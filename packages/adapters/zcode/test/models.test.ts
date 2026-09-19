import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectZcodeModels,
  stateFromZcodeSnapshot,
  ZCODE_CAPABILITIES,
  zcodeModelRef,
  zcodeNativeModel,
} from "../src/models.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("ZCode model configuration", () => {
  it("reads configured provider models without exposing provider credentials", async () => {
    const root = path.join(os.tmpdir(), `codexhost-zcode-models-${crypto.randomUUID()}`);
    roots.push(root);
    mkdirSync(path.join(root, "v2"), { recursive: true });
    writeFileSync(
      path.join(root, "v2/provider_config.json"),
      JSON.stringify({
        config: {
          providerOrder: ["custom"],
          providerConfigRules: {
            providerRules: [
              { providerId: "custom", providerName: "Personal relay", apiKey: "secret" },
            ],
          },
          modelConfigRules: {
            providerModelRules: [
              {
                providerId: "custom",
                modelId: "glm-test",
                config: {
                  enabled: true,
                  optionSpecs: { reasoningLevel: { values: ["off", "high", "max"] } },
                },
              },
            ],
          },
        },
      }),
    );

    const catalog = await inspectZcodeModels({ ZCODE_HOME: root });
    expect(catalog.models).toHaveLength(1);
    expect(catalog.models[0]).toMatchObject({
      label: "glm-test",
      resolvedModelLabel: "glm-test (Personal relay)",
      supportedThinkingOptionIds: ["off", "high", "max"],
    });
    expect(catalog.defaultThinkingOptionId).toBe("max");
    expect(JSON.stringify(catalog)).not.toContain("secret");
    const firstModel = catalog.models[0];
    if (!firstModel) throw new Error("ZCode catalog has no Model");
    expect(zcodeNativeModel(firstModel.ref)).toEqual({
      providerId: "custom",
      modelId: "glm-test",
    });
  });

  it("projects live model, thinking, and permission mode state", () => {
    const model = { providerId: "custom", modelId: "glm-test" };
    expect(
      stateFromZcodeSnapshot({
        settings: {
          model: { current: model },
          thoughtLevel: {
            current: "high",
            available: [{ value: "high", label: "High" }],
          },
          mode: { current: "build" },
        },
      }),
    ).toEqual({
      effectiveModel: zcodeModelRef(model),
      resolvedModelLabel: "glm-test",
      effectiveThinkingOptionId: "high",
      availableThinkingOptions: [{ id: "high", label: "High" }],
      effectivePermissionModeId: "build",
    });
    expect(ZCODE_CAPABILITIES.configuration.permissionModeScope).toBe("live");
  });
});
