import { describe, expect, it } from "vitest";
import {
  TRAEX_CAPABILITIES,
  TRAEX_PERMISSION_MODES,
  traexCatalogModelRef,
  traexConfiguration,
  traexModelRef,
  traexNativeModel,
} from "../src/models.js";

const options = [
  {
    id: "model",
    name: "Model",
    type: "select" as const,
    currentValue: "DeepSeek-V4-Flash",
    options: [
      { value: "DeepSeek-V4-Flash", name: "DeepSeek V4 Flash" },
      { value: "GPT-6-Astra", name: "GPT-6 Astra" },
    ],
  },
  {
    id: "reasoning_effort",
    name: "Reasoning",
    type: "select" as const,
    currentValue: "low",
    options: [
      { value: "low", name: "Low" },
      { value: "max", name: "Max" },
    ],
  },
];

describe("TraeX configuration", () => {
  it("round trips native Model identity and projects independent thinking", () => {
    const ref = traexModelRef("DeepSeek-V4-Flash");
    expect(traexNativeModel(ref)).toBe("DeepSeek-V4-Flash");
    const configuration = traexConfiguration(options, "default");
    expect(configuration.state).toMatchObject({
      effectiveModel: ref,
      resolvedModelLabel: "DeepSeek V4 Flash",
      effectiveThinkingOptionId: "low",
      effectivePermissionModeId: "default",
    });
    expect(configuration.thinkingIds).toEqual(new Set(["low", "max"]));
  });

  it("uses the ACP config value as Model identity and falls back to the display name", () => {
    expect(traexNativeModel(traexCatalogModelRef("GPT-6-Astra", "gpt-6-astra"))).toBe(
      "gpt-6-astra",
    );
    expect(traexNativeModel(traexCatalogModelRef("DeepSeek-V4-Flash", undefined))).toBe(
      "DeepSeek-V4-Flash",
    );
  });

  it("fixes Permission Mode at Session creation", () => {
    expect(TRAEX_CAPABILITIES.configuration.permissionModeScope).toBe("atCreate");
    expect(TRAEX_PERMISSION_MODES.modes.map(({ id }) => id)).toEqual([
      "default",
      "auto",
      "bypass_permissions",
    ]);
  });
});
