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

describe("TraeX Desktop selection", () => {
  it("keeps its model and Thinking selection in the shared plugin route", () => {
    expect(KNOWN_RENDERER_AGENTS).toContain("traex");
    const model = harnessModelRefSchema.parse({ id: "traex.RGVlcFNlZWstVjQtRmxhc2g" });
    const thinking = harnessThinkingOptionIdSchema.parse("max");
    const permission = harnessPermissionModeIdSchema.parse("default");
    const selection = modelSelectionForAgent(null, null, "traex", model, thinking, permission);
    if (typeof selection?.model !== "string") throw new Error("Missing TraeX route");
    expect(decodeHarnessPluginRoute(selection.model)).toEqual({
      harnessId: "traex",
      model,
      thinkingOptionId: thinking,
      permissionModeId: permission,
    });
    expect(
      restoredThreadOwnership({
        owner: "external",
        harnessId: "traex",
        transportModelId: selection.model,
        locked: true,
        effectiveModel: model,
        effectiveThinkingOptionId: thinking,
        availableThinkingOptions: [{ id: thinking, label: "Max" }],
        effectivePermissionModeId: permission,
        history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
      }),
    ).toEqual({ agent: "traex", model, thinkingOptionId: thinking, permissionModeId: permission });
  });

  it("does not leak TraeX state into Codex or DeepSeek Harness", () => {
    const controller = new DraftAgentController<object>();
    const composer = {};
    const model = harnessModelRefSchema.parse({ id: "traex.R1BULTYtQXN0cmE" });
    const thinking = harnessThinkingOptionIdSchema.parse("xhigh");
    controller.mount(composer, ["default"]);
    controller.setExternalModel(composer, "traex", model);
    controller.setExternalThinkingOption(composer, "traex", thinking);
    expect(controller.modelForAgent(composer, "traex")).toEqual(model);
    expect(controller.thinkingOptionForAgent(composer, "traex")).toBe(thinking);
    expect(controller.modelForAgent(composer, "deepseek-harness")).toBeUndefined();
    expect(RENDERER_AGENT_LABELS.traex).toBe("TraeX");
  });
});
