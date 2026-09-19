import type { CreateElicitationRequest } from "@agentclientprotocol/sdk";
import type { HarnessOutput } from "@codexhost/harness-adapter";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";
import { TraexInteractions } from "../src/interactions.js";

describe("TraeX interactions", () => {
  it("projects ACP form elicitation and converts answers back to native values", async () => {
    const emitted: HarnessOutput[] = [];
    const interactions = new TraexInteractions((output) => emitted.push(output));
    const pending = interactions.elicitation(hostTurnIdSchema.parse("turn-1"), {
      mode: "form",
      sessionId: "session-1",
      message: "Choose settings",
      requestedSchema: {
        type: "object",
        required: ["model", "count", "enabled"],
        properties: {
          model: {
            type: "string",
            title: "Model",
            oneOf: [
              { const: "flash", title: "Flash" },
              { const: "pro", title: "Pro" },
            ],
          },
          count: { type: "integer", title: "Count" },
          enabled: { type: "boolean", title: "Enabled" },
        },
      },
    } satisfies CreateElicitationRequest);
    const emittedInteraction = emitted[0];
    expect(emittedInteraction?.kind).toBe("interaction");
    if (emittedInteraction?.kind !== "interaction") throw new Error("Missing interaction");
    expect(emittedInteraction.interaction).toMatchObject({
      type: "question",
      title: "Choose settings",
      questions: [
        { id: "model", type: "choice", optional: false },
        { id: "count", type: "text", optional: false },
        { id: "enabled", type: "choice", optional: false },
      ],
    });
    const responded = interactions.respond({
      type: "interaction.respond",
      interactionId: emittedInteraction.interaction.interactionId,
      response: {
        type: "question",
        answers: { model: ["pro"], count: ["3"], enabled: ["true"] },
      },
    });
    expect(responded.ok).toBe(true);
    await expect(pending).resolves.toEqual({
      action: "accept",
      content: { model: "pro", count: 3, enabled: true },
    });
  });
});
