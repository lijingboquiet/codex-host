import type { HarnessOutput } from "@codexhost/harness-adapter";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";
import { ZcodeInteractions } from "../src/interactions.js";

describe("ZCode interactions", () => {
  it("maps native permission options without changing their response payload", async () => {
    const outputs: HarnessOutput[] = [];
    const interactions = new ZcodeInteractions((output) => outputs.push(output));
    const pending = interactions.permission(hostTurnIdSchema.parse("turn-1"), {
      toolName: "shell",
      reason: "Run tests",
      options: [
        { optionId: "once", name: "Allow once", kind: "once", response: { decision: "allow" } },
        { optionId: "deny", name: "Deny", kind: "deny", response: { decision: "deny" } },
      ],
    });
    const output = outputs[0];
    expect(output).toMatchObject({
      kind: "interaction",
      interaction: { type: "approval", title: "shell" },
    });
    if (output?.kind !== "interaction") throw new Error("Missing permission interaction");
    expect(
      interactions.respond({
        type: "interaction.respond",
        interactionId: output.interaction.interactionId,
        response: { type: "approval", actionId: "once" },
      }),
    ).toEqual({ ok: true, value: { accepted: true } });
    await expect(pending).resolves.toEqual({ decision: "allow" });
  });

  it("maps structured questions back to native answers", async () => {
    const outputs: HarnessOutput[] = [];
    const interactions = new ZcodeInteractions((output) => outputs.push(output));
    const pending = interactions.userInput(hostTurnIdSchema.parse("turn-1"), {
      toolName: "ask",
      questions: [
        {
          header: "Runtime",
          question: "Which runtime?",
          options: [{ value: "node", label: "Node.js" }],
        },
      ],
    });
    const output = outputs[0];
    if (output?.kind !== "interaction") throw new Error("Missing question interaction");
    const result = interactions.respond({
      type: "interaction.respond",
      interactionId: output.interaction.interactionId,
      response: { type: "question", answers: { Runtime: ["node"] } },
    });
    expect(result.ok).toBe(true);
    await expect(pending).resolves.toEqual({
      action: "accept",
      content: { answers: { Runtime: ["node"] } },
    });
  });
});
