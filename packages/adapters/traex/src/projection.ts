import type { SessionNotification, ToolCallContent } from "@agentclientprotocol/sdk";
import { createTwoFilesPatch } from "diff";
import type {
  HostEvent,
  HostFileChange,
  HostItem,
  HostItemOutcome,
  HostItemSnapshot,
  HostThreadSnapshot,
  HostTurnSnapshot,
} from "@codexhost/harness-adapter";
import {
  hostItemIdSchema,
  hostTurnIdSchema,
  jsonValueSchema,
  nativeTurnRefSchema,
  type HostTurnId,
} from "@codexhost/shared-contracts";
import type { TraexNativeTurn } from "./history.js";

const OUTPUT_LIMIT = 100_000;

function fileChanges(content: ToolCallContent[]): HostFileChange[] {
  const changes: HostFileChange[] = [];
  let remaining = OUTPUT_LIMIT;
  for (const entry of content) {
    if (entry.type !== "diff" || entry.oldText === entry.newText) continue;
    const kind = entry.oldText == null ? "add" : "update";
    const unifiedDiff = createTwoFilesPatch(
      kind === "add" ? "/dev/null" : entry.path,
      entry.path,
      entry.oldText ?? "",
      entry.newText,
      undefined,
      undefined,
      { timeout: 100 },
    );
    if (!unifiedDiff || unifiedDiff.length > remaining) continue;
    changes.push({ path: entry.path, kind, unifiedDiff });
    remaining -= unifiedDiff.length;
  }
  return changes;
}

export class TraexTurnOutput {
  #index = 0;
  #text: Extract<HostItem, { type: "agentMessage" | "reasoning" }> | undefined;
  readonly #tools = new Map<
    string,
    { item: Extract<HostItem, { type: "toolExecution" }>; changes: HostFileChange[] }
  >();
  readonly #finishedTools = new Set<string>();

  constructor(
    readonly turnId: HostTurnId,
    readonly emit: (event: HostEvent) => void,
  ) {}

  #finishText(outcome: HostItemOutcome = { status: "succeeded" }) {
    if (this.#text) {
      this.emit({
        type: "item.completed",
        turnId: this.turnId,
        snapshot: { item: this.#text, outcome },
      });
    }
    this.#text = undefined;
  }

  update(notification: SessionNotification) {
    const { update } = notification;
    if (
      update.sessionUpdate === "agent_message_chunk" ||
      update.sessionUpdate === "agent_thought_chunk"
    ) {
      if (update.content.type !== "text" || !update.content.text) return;
      const type = update.sessionUpdate === "agent_message_chunk" ? "agentMessage" : "reasoning";
      if (this.#text?.type !== type) {
        this.#finishText();
        const item: Extract<HostItem, { type: "agentMessage" | "reasoning" }> = {
          type,
          itemId: hostItemIdSchema.parse(`traex-${this.turnId}-${++this.#index}`),
          text: "",
        };
        this.#text = item;
        this.emit({ type: "item.started", turnId: this.turnId, item: { ...item } });
      }
      this.#text.text += update.content.text;
      this.emit({
        type: "item.updated",
        turnId: this.turnId,
        itemId: this.#text.itemId,
        update: { type: "text.append", text: update.content.text },
      });
      return;
    }
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return;
    this.#finishText();
    if (this.#finishedTools.has(update.toolCallId)) return;
    let tool = this.#tools.get(update.toolCallId);
    if (!tool) {
      const args = jsonValueSchema.safeParse(update.rawInput ?? {});
      const item: Extract<HostItem, { type: "toolExecution" }> = {
        type: "toolExecution",
        itemId: hostItemIdSchema.parse(`traex-${this.turnId}-${++this.#index}`),
        toolName: update.title ?? "TraeX tool",
        arguments: args.success ? args.data : {},
      };
      tool = { item, changes: [] };
      this.#tools.set(update.toolCallId, tool);
      this.emit({ type: "item.started", turnId: this.turnId, item: { ...item } });
    }
    if (update.content != null) {
      tool.changes = fileChanges(update.content);
      const output = update.content
        .flatMap((entry) =>
          entry.type === "content" && entry.content.type === "text"
            ? [entry.content.text]
            : entry.type === "diff"
              ? [`${entry.path}\n${entry.newText}`]
              : [],
        )
        .join("\n");
      tool.item.output = {
        content: [{ type: "text", text: output.slice(0, OUTPUT_LIMIT) }],
        ...(output.length > OUTPUT_LIMIT ? { truncated: true } : {}),
      };
      this.emit({
        type: "item.updated",
        turnId: this.turnId,
        itemId: tool.item.itemId,
        update: { type: "output.replace", output: tool.item.output },
      });
    }
    if (update.status === "completed" || update.status === "failed") {
      const outcome: HostItemOutcome =
        update.status === "completed"
          ? { status: "succeeded" }
          : {
              status: "failed",
              error: {
                code: "nativeFailure",
                message: "TraeX tool failed",
                retryable: false,
              },
            };
      this.emit({
        type: "item.completed",
        turnId: this.turnId,
        snapshot: { item: tool.item, outcome },
      });
      if (update.status === "completed" && tool.changes.length) {
        const item: HostItem = {
          type: "fileChange",
          itemId: hostItemIdSchema.parse(`traex-${this.turnId}-${++this.#index}`),
          changes: tool.changes,
        };
        this.emit({ type: "item.started", turnId: this.turnId, item });
        this.emit({
          type: "item.completed",
          turnId: this.turnId,
          snapshot: { item, outcome: { status: "succeeded" } },
        });
      }
      this.#tools.delete(update.toolCallId);
      this.#finishedTools.add(update.toolCallId);
    }
  }

  finish(outcome: HostItemOutcome) {
    this.#finishText(outcome);
    for (const { item } of this.#tools.values()) {
      this.emit({
        type: "item.completed",
        turnId: this.turnId,
        snapshot: {
          item,
          outcome:
            outcome.status === "succeeded"
              ? {
                  status: "failed",
                  error: {
                    code: "protocolError",
                    message: "TraeX did not report tool completion",
                    retryable: false,
                  },
                }
              : outcome,
        },
      });
    }
    this.#tools.clear();
  }
}

export function traexSnapshot(
  sessionId: string,
  native: TraexNativeTurn[],
  replay: SessionNotification[],
): HostThreadSnapshot {
  const groups: Array<{ text: string; events: SessionNotification[] }> = [];
  for (const notification of replay) {
    if (notification.sessionId !== sessionId) throw new Error("TraeX replay Session mismatch");
    if (notification.update.sessionUpdate === "user_message_chunk") {
      if (notification.update.content.type !== "text")
        throw new Error("TraeX replay contains unsupported user input");
      groups.push({ text: notification.update.content.text, events: [] });
    } else {
      groups.at(-1)?.events.push(notification);
    }
  }
  if (groups.length !== native.length) throw new Error("TraeX replay/native Turn count mismatch");
  const turns: HostTurnSnapshot[] = groups.map((group, index) => {
    const identity = native[index];
    if (!identity || identity.text !== group.text)
      throw new Error("TraeX replay/native prompt mismatch");
    const items: HostItemSnapshot[] = [];
    const output = new TraexTurnOutput(hostTurnIdSchema.parse(identity.id), (event) => {
      if (event.type === "item.completed") items.push(event.snapshot);
    });
    for (const event of group.events) output.update(event);
    output.finish({ status: "succeeded" });
    return {
      nativeTurnRef: nativeTurnRefSchema.parse({
        harnessId: "traex",
        nativeSessionId: sessionId,
        nativeTurnKey: identity.id,
        formatVersion: 1,
      }),
      input: [{ type: "text", text: group.text }],
      items,
      outcome: {
        status: "unknown",
        reason: "TraeX ACP history does not expose the terminal stop reason",
      },
    };
  });
  return { turns };
}
