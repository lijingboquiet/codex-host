import { describe, expect, it } from "vitest";
import { zcodeSnapshot } from "../src/history.js";

describe("ZCode Native history", () => {
  it("correlates persisted messages with stable Native Turn identities", () => {
    const history = zcodeSnapshot(
      "session-1",
      {
        messages: [
          {
            info: { role: "user", messageId: "user-1", model: { providerId: "p", modelId: "m" } },
            parts: [],
          },
          {
            info: { role: "assistant", messageId: "assistant-1", parentMessageId: "user-1" },
            parts: [{ type: "text", text: "world" }],
          },
        ],
      },
      {
        events: [
          {
            type: "turn.started",
            turnId: "native-turn-1",
            timestamp: 10,
            payload: { input: "hello", messageId: "user-1" },
          },
          {
            type: "turn.completed",
            turnId: "native-turn-1",
            timestamp: 20,
            payload: { resultType: "success", response: "world" },
          },
        ],
      },
    );
    expect(history.turns).toHaveLength(1);
    expect(history.turns[0]).toMatchObject({
      nativeTurnRef: {
        harnessId: "zcode",
        nativeSessionId: "session-1",
        nativeTurnKey: "native-turn-1",
      },
      input: [{ type: "text", text: "hello" }],
      items: [{ item: { type: "agentMessage", text: "world" }, outcome: { status: "succeeded" } }],
      outcome: { status: "succeeded" },
      startedAtMs: 10,
      completedAtMs: 20,
    });
  });
});
