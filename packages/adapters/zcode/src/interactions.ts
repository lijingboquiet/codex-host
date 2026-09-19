import { randomUUID } from "node:crypto";
import {
  validateHostInteractionResponse,
  type HarnessOutput,
  type HarnessResult,
  type HostApprovalInteraction,
  type HostInteraction,
  type HostQuestion,
  type HostQuestionInteraction,
  type InteractionRespondAccepted,
  type InteractionRespondCommand,
} from "@codexhost/harness-adapter";
import {
  hostInteractionIdSchema,
  type HostInteractionId,
  type HostTurnId,
  type JsonObject,
  type JsonValue,
} from "@codexhost/shared-contracts";

interface PendingInteraction {
  interaction: HostInteraction;
  resolve(value: JsonValue): void;
  native: JsonObject;
}

function record(value: JsonValue | undefined): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function text(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export class ZcodeInteractions {
  readonly #pending = new Map<HostInteractionId, PendingInteraction>();

  constructor(readonly emit: (output: HarnessOutput) => void) {}

  permission(turnId: HostTurnId, params: JsonObject): Promise<JsonValue> {
    const options = Array.isArray(params.options) ? params.options.map(record) : [];
    if (!options.length) return Promise.resolve({ decision: "deny" });
    const interactionId = hostInteractionIdSchema.parse(randomUUID());
    const description = text(params.reason);
    const interaction: HostApprovalInteraction = {
      type: "approval",
      interactionId,
      turnId,
      title: text(params.toolName) ?? "ZCode tool approval",
      ...(description ? { description } : {}),
      subject: { type: "nativeAction" },
      actions: options.flatMap((option) => {
        const id = text(option.optionId);
        const label = text(option.name);
        const response = record(option.response);
        const decision = text(response.decision);
        if (!id || !label || !decision) return [];
        const kind = text(option.kind)?.toLowerCase() ?? "";
        return [
          {
            id,
            label,
            effect:
              decision === "deny"
                ? ("deny" as const)
                : kind.includes("always")
                  ? ("allowAlways" as const)
                  : ("allowOnce" as const),
          },
        ];
      }),
    };
    if (!interaction.actions.length) return Promise.resolve({ decision: "deny" });
    return this.#wait(interaction, params);
  }

  userInput(turnId: HostTurnId, params: JsonObject): Promise<JsonValue> {
    const interactionId = hostInteractionIdSchema.parse(randomUUID());
    const nativeQuestions = Array.isArray(params.questions) ? params.questions.map(record) : [];
    let questions: HostQuestion[];
    if (nativeQuestions.length) {
      questions = nativeQuestions.map((question, index) => {
        const options = Array.isArray(question.options) ? question.options.map(record) : [];
        return {
          id: text(question.header) ?? `question-${index + 1}`,
          type: "choice" as const,
          prompt: text(question.question) ?? text(question.header) ?? "ZCode question",
          options: options.flatMap((option) => {
            const value = text(option.value);
            const label = text(option.label);
            const description = text(option.description);
            return value && label
              ? [{ value, label, ...(description ? { description } : {}) }]
              : [];
          }),
          multiple: question.multiSelect === true,
          allowOther: true,
          optional: false,
        };
      });
    } else {
      questions = [
        {
          id: "answer",
          type: "text",
          prompt: text(params.prompt) ?? "ZCode needs more information",
          multiline: true,
          secret: false,
          optional: false,
        },
      ];
    }
    const title = text(params.toolName);
    const interaction: HostQuestionInteraction = {
      type: "question",
      interactionId,
      turnId,
      ...(title ? { title } : {}),
      questions,
    };
    return this.#wait(interaction, params);
  }

  respond(command: InteractionRespondCommand): HarnessResult<InteractionRespondAccepted> {
    const pending = this.#pending.get(command.interactionId);
    if (!pending) {
      return {
        ok: false,
        error: {
          code: "invalidState",
          message: "ZCode Interaction Response must reference a pending Interaction",
          retryable: false,
        },
      };
    }
    const validation = validateHostInteractionResponse(pending.interaction, command.response);
    if (validation) return { ok: false, error: validation };
    this.#pending.delete(command.interactionId);
    this.emit({
      kind: "event",
      event: {
        type: "interaction.closed",
        interactionId: command.interactionId,
        turnId: pending.interaction.turnId,
        reason: "responded",
      },
    });
    if (command.response.type === "approval") {
      const actionId = command.response.actionId;
      const option = (Array.isArray(pending.native.options) ? pending.native.options : [])
        .map(record)
        .find((candidate) => candidate.optionId === actionId);
      pending.resolve(option ? record(option.response) : { decision: "deny" });
    } else if (command.response.type === "question") {
      pending.resolve(
        command.response.cancelled
          ? { action: "cancel" }
          : { action: "accept", content: { answers: command.response.answers } },
      );
    } else {
      pending.resolve({ action: "cancel" });
    }
    return { ok: true, value: { accepted: true } };
  }

  cancel(): void {
    for (const [interactionId, pending] of this.#pending) {
      this.emit({
        kind: "event",
        event: {
          type: "interaction.closed",
          interactionId,
          turnId: pending.interaction.turnId,
          reason: "cancelled",
        },
      });
      pending.resolve(
        pending.interaction.type === "approval" ? { decision: "deny" } : { action: "cancel" },
      );
    }
    this.#pending.clear();
  }

  #wait(interaction: HostInteraction, native: JsonObject): Promise<JsonValue> {
    return new Promise((resolve) => {
      this.#pending.set(interaction.interactionId, { interaction, resolve, native });
      this.emit({ kind: "interaction", interaction });
    });
  }
}
