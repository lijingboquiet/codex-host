import { randomUUID } from "node:crypto";
import {
  ElicitationPropertySchema,
  MultiSelectItems,
  CreateElicitationRequest,
  type CreateElicitationResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import {
  validateHostInteractionResponse,
  type HarnessOutput,
  type HarnessResult,
  type HostInteraction,
  type HostInteractionResponse,
  type InteractionRespondAccepted,
  type InteractionRespondCommand,
} from "@codexhost/harness-adapter";
import { hostInteractionIdSchema, type HostTurnId } from "@codexhost/shared-contracts";

export class TraexInteractions {
  readonly #pending = new Map<
    string,
    {
      interaction: HostInteraction;
      resolve: (response: HostInteractionResponse | undefined) => void;
    }
  >();

  constructor(readonly emit: (output: HarnessOutput) => void) {}

  #ask(interaction: HostInteraction): Promise<HostInteractionResponse | undefined> {
    return new Promise((resolve) => {
      this.#pending.set(interaction.interactionId, { interaction, resolve });
      this.emit({ kind: "interaction", interaction });
    });
  }

  async permission(
    turnId: HostTurnId,
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const interaction: HostInteraction = {
      type: "approval",
      interactionId: hostInteractionIdSchema.parse(randomUUID()),
      turnId,
      title: request.toolCall.title ?? "TraeX tool approval",
      subject: { type: "nativeAction" },
      actions: request.options.map((option) => ({
        id: option.optionId,
        label: option.name,
        effect:
          option.kind === "allow_once"
            ? "allowOnce"
            : option.kind === "allow_always"
              ? "allowAlways"
              : "deny",
      })),
    };
    const response = await this.#ask(interaction);
    return response?.type === "approval"
      ? { outcome: { outcome: "selected", optionId: response.actionId } }
      : { outcome: { outcome: "cancelled" } };
  }

  async elicitation(
    turnId: HostTurnId,
    request: CreateElicitationRequest,
  ): Promise<CreateElicitationResponse> {
    if (!CreateElicitationRequest.isForm(request)) return { action: "cancel" };
    const required = new Set(request.requestedSchema.required ?? []);
    const schemas = request.requestedSchema.properties ?? {};
    const questions = Object.entries(schemas).map(([id, schema]) => {
      const prompt =
        typeof schema.title === "string"
          ? schema.title
          : typeof schema.description === "string"
            ? schema.description
            : id;
      const optional = !required.has(id);
      if (ElicitationPropertySchema.isString(schema)) {
        const options =
          schema.oneOf?.map(({ const: value, title, description }) => ({
            value,
            label: title,
            ...(description ? { description } : {}),
          })) ?? schema.enum?.map((value) => ({ value, label: value }));
        if (options) {
          return {
            id,
            type: "choice" as const,
            prompt,
            options,
            multiple: false,
            allowOther: false,
            optional,
          };
        }
        return {
          id,
          type: "text" as const,
          prompt,
          multiline: true,
          secret: false,
          optional,
          ...(schema.default != null ? { prefill: schema.default } : {}),
        };
      }
      if (ElicitationPropertySchema.isArray(schema)) {
        const options = MultiSelectItems.isTitled(schema.items)
          ? schema.items.anyOf.map(({ const: value, title, description }) => ({
              value,
              label: title,
              ...(description ? { description } : {}),
            }))
          : MultiSelectItems.isString(schema.items)
            ? schema.items.enum.map((value) => ({ value, label: value }))
            : [];
        if (!options.length) throw new Error(`Unsupported TraeX elicitation field '${id}'`);
        return {
          id,
          type: "choice" as const,
          prompt,
          options,
          multiple: true,
          allowOther: false,
          optional,
        };
      }
      if (ElicitationPropertySchema.isBoolean(schema)) {
        return {
          id,
          type: "choice" as const,
          prompt,
          options: [
            { value: "true", label: "Yes" },
            { value: "false", label: "No" },
          ],
          multiple: false,
          allowOther: false,
          optional,
        };
      }
      if (
        ElicitationPropertySchema.isNumber(schema) ||
        ElicitationPropertySchema.isInteger(schema)
      ) {
        return {
          id,
          type: "text" as const,
          prompt,
          multiline: false,
          secret: false,
          optional,
          ...(schema.default != null ? { prefill: String(schema.default) } : {}),
        };
      }
      throw new Error(`Unsupported TraeX elicitation field '${id}'`);
    });
    const response = await this.#ask({
      type: "question",
      interactionId: hostInteractionIdSchema.parse(randomUUID()),
      turnId,
      title: request.message,
      questions,
    });
    if (response?.type !== "question" || response.cancelled) return { action: "cancel" };
    const content: Record<string, string | number | boolean | string[]> = {};
    for (const [id, answers] of Object.entries(response.answers)) {
      const schema = schemas[id];
      const first = answers[0];
      if (!schema || first === undefined) continue;
      if (ElicitationPropertySchema.isArray(schema)) content[id] = answers;
      else if (ElicitationPropertySchema.isBoolean(schema)) content[id] = first === "true";
      else if (ElicitationPropertySchema.isNumber(schema)) content[id] = Number(first);
      else if (ElicitationPropertySchema.isInteger(schema))
        content[id] = Number.parseInt(first, 10);
      else content[id] = first;
    }
    return { action: "accept", content };
  }

  respond(command: InteractionRespondCommand): HarnessResult<InteractionRespondAccepted> {
    const pending = this.#pending.get(command.interactionId);
    const error = validateHostInteractionResponse(pending?.interaction, command.response);
    if (error || !pending) {
      return {
        ok: false,
        error: error ?? {
          code: "invalidState",
          message: "Interaction is no longer pending",
          retryable: false,
        },
      };
    }
    this.#pending.delete(command.interactionId);
    this.emit({
      kind: "event",
      event: {
        type: "interaction.closed",
        interactionId: pending.interaction.interactionId,
        turnId: pending.interaction.turnId,
        reason: "responded",
      },
    });
    pending.resolve(command.response);
    return { ok: true, value: { accepted: true } };
  }

  cancel() {
    for (const { interaction, resolve } of this.#pending.values()) {
      this.emit({
        kind: "event",
        event: {
          type: "interaction.closed",
          interactionId: interaction.interactionId,
          turnId: interaction.turnId,
          reason: "cancelled",
        },
      });
      resolve(undefined);
    }
    this.#pending.clear();
  }
}
