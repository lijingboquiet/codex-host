import type { HostThreadSnapshot, HostTurnSnapshot } from "@codexhost/harness-adapter";
import {
  harnessModelRefSchema,
  hostItemIdSchema,
  nativeTurnRefSchema,
  type JsonObject,
  type JsonValue,
} from "@codexhost/shared-contracts";
import { zcodeModelRef } from "./models.js";
import { zcodeMessageItems } from "./projection.js";

function record(value: JsonValue | undefined): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function text(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function number(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function historyOutcome(event: JsonObject | undefined): HostTurnSnapshot["outcome"] {
  if (!event) return { status: "unknown", reason: "ZCode Turn has no terminal event" };
  const payload = record(event.payload);
  if (event.type === "turn.completed") {
    return payload.resultType === "cancelled"
      ? { status: "cancelled", reason: "Cancelled by user" }
      : payload.resultType === "success"
        ? { status: "succeeded" }
        : {
            status: "failed",
            error: {
              code: "nativeFailure",
              message: `ZCode stopped: ${text(payload.resultType) ?? "unknown result"}`,
              retryable: false,
            },
          };
  }
  const error = record(payload.error);
  return {
    status: "failed",
    error: {
      code: "nativeFailure",
      message: text(error.message) ?? "ZCode Turn failed",
      retryable: error.retryable === true,
    },
  };
}

export function zcodeSnapshot(
  sessionId: string,
  snapshot: JsonObject,
  eventResult: JsonObject,
): HostThreadSnapshot {
  const messages = Array.isArray(snapshot.messages)
    ? snapshot.messages.map(record)
    : Array.isArray(eventResult.messages)
      ? eventResult.messages.map(record)
      : [];
  const events = Array.isArray(eventResult.events) ? eventResult.events.map(record) : [];
  const assistantsByParent = new Map<string, JsonObject[]>();
  for (const message of messages) {
    const info = record(message.info);
    if (info.role !== "assistant") continue;
    const parent = text(info.parentMessageId);
    if (!parent) continue;
    const grouped = assistantsByParent.get(parent) ?? [];
    grouped.push(message);
    assistantsByParent.set(parent, grouped);
  }
  const terminals = new Map<string, JsonObject>();
  for (const event of events) {
    if (
      (event.type === "turn.completed" || event.type === "turn.failed") &&
      typeof event.turnId === "string"
    ) {
      terminals.set(event.turnId, event);
    }
  }
  const turns: HostTurnSnapshot[] = [];
  for (const event of events) {
    if (event.type !== "turn.started" || typeof event.turnId !== "string") continue;
    const payload = record(event.payload);
    const input = text(payload.input) ?? "";
    const userMessageId = text(payload.messageId);
    const user = userMessageId
      ? messages.find((message) => record(message.info).messageId === userMessageId)
      : undefined;
    const userInfo = record(user?.info);
    const model = record(userInfo.model);
    const terminal = terminals.get(event.turnId);
    const assistantMessages = userMessageId ? (assistantsByParent.get(userMessageId) ?? []) : [];
    const terminalPayload = record(terminal?.payload);
    const startedAtMs = number(event.timestamp);
    const completedAtMs = number(terminal?.timestamp);
    turns.push({
      nativeTurnRef: nativeTurnRefSchema.parse({
        harnessId: "zcode",
        nativeSessionId: sessionId,
        nativeTurnKey: event.turnId,
        formatVersion: 1,
      }),
      input: [{ type: "text", text: input }],
      items: assistantMessages.flatMap(zcodeMessageItems),
      outcome: historyOutcome(terminal),
      ...(typeof model.providerId === "string" && typeof model.modelId === "string"
        ? {
            model: harnessModelRefSchema.parse(
              zcodeModelRef({ providerId: model.providerId, modelId: model.modelId }),
            ),
          }
        : {}),
      ...(startedAtMs !== undefined ? { startedAtMs } : {}),
      ...(completedAtMs !== undefined ? { completedAtMs } : {}),
    });
    if (
      terminal?.type === "turn.completed" &&
      typeof terminalPayload.response === "string" &&
      terminalPayload.response &&
      assistantMessages.length === 0
    ) {
      turns.at(-1)?.items.push({
        item: {
          type: "agentMessage",
          itemId: hostItemIdSchema.parse(`zcode-history-${event.turnId}-response`),
          text: terminalPayload.response,
        },
        outcome: { status: "succeeded" },
      });
    }
  }
  return { turns };
}
