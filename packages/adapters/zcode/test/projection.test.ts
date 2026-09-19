import type { HostEvent } from "@codexhost/harness-adapter";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";
import { ZcodeTurnProjection, zcodeMessageItems } from "../src/projection.js";
import type { ZcodeEvent } from "../src/transport.js";

function nativeEvent(type: string, payload: ZcodeEvent["payload"]): ZcodeEvent {
  return {
    type,
    ...(payload !== undefined ? { payload } : {}),
    sessionId: "session-1",
    turnId: "native-turn-1",
    eventId: crypto.randomUUID(),
    seq: 1,
    timestamp: Date.now(),
  };
}

describe("ZCode Turn projection", () => {
  it("streams reasoning, visible text, and tool completion", () => {
    const events: HostEvent[] = [];
    const projection = new ZcodeTurnProjection(hostTurnIdSchema.parse("host-turn-1"), (event) =>
      events.push(event),
    );
    projection.update(nativeEvent("model.streaming", { kind: "reasoning_delta", delta: "think" }));
    projection.update(nativeEvent("model.streaming", { kind: "text_delta", delta: "hello" }));
    projection.update(
      nativeEvent("tool.updated", {
        kind: "scheduled",
        toolCallId: "tool-1",
        toolName: "read",
        input: { path: "README.md" },
      }),
    );
    projection.update(
      nativeEvent("tool.updated", {
        kind: "progress",
        toolCallId: "tool-1",
        stdoutTail: "working",
      }),
    );
    projection.update(
      nativeEvent("tool.updated", {
        kind: "result",
        toolCallId: "tool-1",
        result: { output: "done" },
      }),
    );
    expect(events.filter((event) => event.type === "item.completed")).toHaveLength(3);
    projection.finish({ status: "succeeded" });

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "item.started",
          item: expect.objectContaining({ type: "reasoning" }),
        }),
        expect.objectContaining({
          type: "item.started",
          item: expect.objectContaining({ type: "agentMessage" }),
        }),
        expect.objectContaining({
          type: "item.started",
          item: expect.objectContaining({
            type: "toolExecution",
            toolName: "read",
            arguments: { path: "README.md" },
          }),
        }),
        expect.objectContaining({
          type: "item.completed",
          snapshot: expect.objectContaining({ outcome: { status: "succeeded" } }),
        }),
      ]),
    );
  });

  it("restores persisted text and failed tool items", () => {
    expect(
      zcodeMessageItems({
        info: { messageId: "assistant-1" },
        parts: [
          { type: "text", text: "answer" },
          {
            type: "tool",
            tool: "shell",
            state: { status: "error", input: { command: "false" }, error: "exit 1" },
          },
          { type: "compaction" },
        ],
      }),
    ).toEqual([
      expect.objectContaining({
        item: expect.objectContaining({ type: "agentMessage", text: "answer" }),
      }),
      expect.objectContaining({
        item: expect.objectContaining({ type: "toolExecution", toolName: "shell" }),
        outcome: expect.objectContaining({ status: "failed" }),
      }),
      expect.objectContaining({ item: expect.objectContaining({ type: "contextCompaction" }) }),
    ]);
  });
});
