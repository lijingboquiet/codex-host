import { describe, expect, it } from "vitest";
import {
  decodeHarnessPluginRoute,
  harnessModelRefSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
} from "@codexhost/shared-contracts";
import { DraftAgentController, KNOWN_RENDERER_AGENTS } from "../src/agent-selection-state.js";
import { restoredThreadOwnership } from "../src/renderer-binding-probe.js";
import { RENDERER_AGENT_LABELS } from "../src/renderer-agent-icon.js";
import { modelSelectionForAgent } from "../src/versioned-renderer-adapter.js";

describe("ZCode Desktop selection", () => {
  it("keeps its model, Thinking, and live mode in the shared plugin route", () => {
    expect(KNOWN_RENDERER_AGENTS).toContain("zcode");
    const model = harnessModelRefSchema.parse({ id: "zcode.W1wicFwiLFwibVwiXQ" });
    const thinking = harnessThinkingOptionIdSchema.parse("max");
    const permission = harnessPermissionModeIdSchema.parse("build");
    const selection = modelSelectionForAgent(null, null, "zcode", model, thinking, permission);
    if (typeof selection?.model !== "string") throw new Error("Missing ZCode route");
    expect(decodeHarnessPluginRoute(selection.model)).toEqual({
      harnessId: "zcode",
      model,
      thinkingOptionId: thinking,
      permissionModeId: permission,
    });
    expect(
      restoredThreadOwnership({
        owner: "external",
        harnessId: "zcode",
        transportModelId: selection.model,
        locked: true,
        effectiveModel: model,
        effectiveThinkingOptionId: thinking,
        availableThinkingOptions: [{ id: thinking, label: "Max" }],
        effectivePermissionModeId: permission,
        history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
      }),
    ).toEqual({ agent: "zcode", model, thinkingOptionId: thinking, permissionModeId: permission });
  });

  it("keeps ZCode draft state independent from TraeX and Codex", () => {
    const controller = new DraftAgentController<object>();
    const composer = {};
    const model = harnessModelRefSchema.parse({ id: "zcode.W1wicFwiLFwibVwiXQ" });
    const thinking = harnessThinkingOptionIdSchema.parse("xhigh");
    controller.mount(composer, ["default"]);
    controller.setExternalModel(composer, "zcode", model);
    controller.setExternalThinkingOption(composer, "zcode", thinking);
    expect(controller.modelForAgent(composer, "zcode")).toEqual(model);
    expect(controller.thinkingOptionForAgent(composer, "zcode")).toBe(thinking);
    expect(controller.modelForAgent(composer, "traex")).toBeUndefined();
    expect(RENDERER_AGENT_LABELS.zcode).toBe("ZCode");
  });
});
