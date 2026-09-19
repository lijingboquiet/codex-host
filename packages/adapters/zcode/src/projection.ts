import type {
  HostEvent,
  HostItem,
  HostItemOutcome,
  HostItemSnapshot,
} from "@codexhost/harness-adapter";
import {
  hostItemIdSchema,
  jsonValueSchema,
  type HostTurnId,
  type JsonObject,
  type JsonValue,
} from "@codexhost/shared-contracts";
import type { ZcodeEvent } from "./transport.js";

const OUTPUT_LIMIT = 100_000;

function record(value: JsonValue | undefined): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function string(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function bounded(value: string): { text: string; truncated?: true } {
  return value.length > OUTPUT_LIMIT
    ? { text: value.slice(0, OUTPUT_LIMIT), truncated: true }
    : { text: value };
}

export class ZcodeTurnProjection {
  #index = 0;
  #text: Extract<HostItem, { type: "agentMessage" | "reasoning" }> | undefined;
  readonly #tools = new Map<string, Extract<HostItem, { type: "toolExecution" }>>();
  readonly #completedTools = new Set<string>();
  sawText = false;

  constructor(
    readonly turnId: HostTurnId,
    readonly emit: (event: HostEvent) => void,
  ) {}

  update(event: ZcodeEvent): void {
    const payload = record(event.payload);
    if (event.type === "model.streaming") {
      const kind = string(payload.kind);
      if (kind === "text_start" || kind === "reasoning_start") {
        this.#startText(kind === "text_start" ? "agentMessage" : "reasoning");
      } else if (kind === "text_delta" || kind === "reasoning_delta") {
        const text = string(payload.delta);
        if (!text) return;
        const type = kind === "text_delta" ? "agentMessage" : "reasoning";
        if (this.#text?.type !== type) this.#startText(type);
        if (!this.#text) return;
        this.#text.text += text;
        this.sawText ||= type === "agentMessage";
        this.emit({
          type: "item.updated",
          turnId: this.turnId,
          itemId: this.#text.itemId,
          update: { type: "text.append", text },
        });
      } else if (kind === "text_end" || kind === "reasoning_end") {
        this.#finishText();
      }
      return;
    }
    if (event.type !== "tool.updated") return;
    this.#finishText();
    const callId = string(payload.toolCallId);
    const kind = string(payload.kind);
    if (!callId || !kind || this.#completedTools.has(callId)) return;
    let item = this.#tools.get(callId);
    if (!item) {
      const arguments_ = jsonValueSchema.safeParse(payload.input ?? {});
      item = {
        type: "toolExecution",
        itemId: this.#itemId(`tool-${callId}`),
        toolName: string(payload.toolName) ?? "ZCode tool",
        arguments: arguments_.success ? arguments_.data : {},
      };
      this.#tools.set(callId, item);
      this.emit({ type: "item.started", turnId: this.turnId, item: { ...item } });
    }
    if (kind === "scheduled" || kind === "started") return;
    if (kind === "progress") {
      const output = [
        string(payload.stdoutTail),
        string(payload.stderrTail),
        string(payload.outputTail),
      ]
        .filter((value): value is string => Boolean(value))
        .join("\n");
      if (output) this.#replaceOutput(item, output);
      return;
    }
    if (kind === "result") {
      const result = payload.result;
      this.#replaceOutput(
        item,
        typeof result === "string" ? result : JSON.stringify(result ?? null),
      );
      this.#completeTool(callId, item, { status: "succeeded" });
    } else if (kind === "error") {
      const error = record(payload.error);
      this.#completeTool(callId, item, {
        status: "failed",
        error: {
          code: "nativeFailure",
          message: string(error.message) ?? `ZCode tool '${item.toolName}' failed`,
          retryable: error.retryable === true,
        },
      });
    }
  }

  appendTerminalText(text: string): void {
    if (!text || this.sawText) return;
    this.#startText("agentMessage");
    if (!this.#text) return;
    this.#text.text = text;
    this.sawText = true;
    this.emit({
      type: "item.updated",
      turnId: this.turnId,
      itemId: this.#text.itemId,
      update: { type: "text.append", text },
    });
  }

  finish(outcome: HostItemOutcome): void {
    this.#finishText(outcome);
    for (const [callId, item] of this.#tools) {
      this.#completeTool(
        callId,
        item,
        outcome.status === "succeeded"
          ? {
              status: "failed",
              error: {
                code: "protocolError",
                message: "ZCode did not report tool completion",
                retryable: false,
              },
            }
          : outcome,
      );
    }
  }

  #startText(type: "agentMessage" | "reasoning"): void {
    if (this.#text?.type === type) return;
    this.#finishText();
    const item = { type, itemId: this.#itemId(type), text: "" } as Extract<
      HostItem,
      { type: "agentMessage" | "reasoning" }
    >;
    this.#text = item;
    this.emit({ type: "item.started", turnId: this.turnId, item: { ...item } });
  }

  #finishText(outcome: HostItemOutcome = { status: "succeeded" }): void {
    if (!this.#text) return;
    this.emit({
      type: "item.completed",
      turnId: this.turnId,
      snapshot: { item: this.#text, outcome },
    });
    this.#text = undefined;
  }

  #replaceOutput(item: Extract<HostItem, { type: "toolExecution" }>, text: string): void {
    const value = bounded(text);
    item.output = {
      content: [{ type: "text", text: value.text }],
      ...(value.truncated ? { truncated: true } : {}),
    };
    this.emit({
      type: "item.updated",
      turnId: this.turnId,
      itemId: item.itemId,
      update: { type: "output.replace", output: item.output },
    });
  }

  #completeTool(
    callId: string,
    item: Extract<HostItem, { type: "toolExecution" }>,
    outcome: HostItemOutcome,
  ): void {
    this.emit({
      type: "item.completed",
      turnId: this.turnId,
      snapshot: { item, outcome },
    });
    this.#tools.delete(callId);
    this.#completedTools.add(callId);
  }

  #itemId(suffix: string) {
    return hostItemIdSchema.parse(`zcode-${this.turnId}-${++this.#index}-${suffix}`);
  }
}

export function zcodeMessageItems(message: JsonObject): HostItemSnapshot[] {
  const items: HostItemSnapshot[] = [];
  const info = record(message.info);
  const parts = Array.isArray(message.parts) ? message.parts.map(record) : [];
  for (const [index, part] of parts.entries()) {
    const type = string(part.type);
    const baseId = hostItemIdSchema.parse(
      `zcode-history-${String(info.messageId ?? index)}-${index}`,
    );
    if ((type === "text" || type === "reasoning") && typeof part.text === "string") {
      items.push({
        item: {
          type: type === "text" ? "agentMessage" : "reasoning",
          itemId: baseId,
          text: part.text,
        },
        outcome: { status: "succeeded" },
      });
    } else if (type === "tool") {
      const state = record(part.state);
      const status = string(state.status);
      const output = string(state.output) ?? string(state.error);
      items.push({
        item: {
          type: "toolExecution",
          itemId: baseId,
          toolName: string(part.tool) ?? "ZCode tool",
          arguments: jsonValueSchema.safeParse(state.input).success ? (state.input ?? {}) : {},
          ...(output
            ? { output: { content: [{ type: "text", text: bounded(output).text }] } }
            : {}),
        },
        outcome:
          status === "error"
            ? {
                status: "failed",
                error: {
                  code: "nativeFailure",
                  message: string(state.error) ?? "ZCode tool failed",
                  retryable: false,
                },
              }
            : status === "completed"
              ? { status: "succeeded" }
              : { status: "cancelled", reason: "ZCode tool history is incomplete" },
      });
    } else if (type === "compaction") {
      items.push({
        item: { type: "contextCompaction", itemId: baseId },
        outcome: { status: "succeeded" },
      });
    }
  }
  return items;
}
