import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  HarnessModelCatalog,
  HarnessModelRef,
  HarnessPermissionModeCatalog,
  HarnessSessionCapabilities,
  HarnessSessionState,
} from "@codexhost/harness-adapter";
import {
  harnessModelCatalogSchema,
  harnessModelRefSchema,
  harnessPermissionModeCatalogSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  harnessThinkingOptionSchema,
} from "@codexhost/shared-contracts";

export interface ZcodeModelSelection {
  providerId: string;
  modelId: string;
}

export const ZCODE_CAPABILITIES: HarnessSessionCapabilities = {
  configuration: {
    selectModel: true,
    selectThinkingOption: true,
    selectPermissionMode: true,
    permissionModeScope: "live",
  },
  history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
};

export const ZCODE_PERMISSION_MODES: HarnessPermissionModeCatalog =
  harnessPermissionModeCatalogSchema.parse({
    defaultModeId: "build",
    modes: [
      { id: "plan", label: "Plan", description: "Plan without making workspace changes." },
      { id: "build", label: "Build", description: "Build with ZCode's normal approvals." },
      { id: "edit", label: "Edit", description: "Allow workspace edits with native safeguards." },
      { id: "auto", label: "Auto", description: "Let ZCode select the collaboration mode." },
      {
        id: "yolo",
        label: "Full access",
        description: "Run all tool actions without approval prompts.",
        dangerous: true,
      },
    ],
  });

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function zcodeModelRef(selection: ZcodeModelSelection): HarnessModelRef {
  return harnessModelRefSchema.parse({
    id: `zcode.${Buffer.from(JSON.stringify([selection.providerId, selection.modelId]), "utf8").toString("base64url")}`,
  });
}

export function zcodeNativeModel(ref: HarnessModelRef): ZcodeModelSelection {
  if (!ref.id.startsWith("zcode.")) throw new Error("Invalid ZCode Model Ref");
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(ref.id.slice(6), "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid ZCode Model Ref");
  }
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== "string" ||
    !value[0] ||
    typeof value[1] !== "string" ||
    !value[1]
  ) {
    throw new Error("Invalid ZCode Model Ref");
  }
  const selection = { providerId: value[0], modelId: value[1] };
  if (zcodeModelRef(selection).id !== ref.id) throw new Error("Invalid ZCode Model Ref");
  return selection;
}

function zcodeHome(environment: NodeJS.ProcessEnv): string {
  return environment.ZCODE_HOME ?? path.join(environment.HOME ?? os.homedir(), ".zcode");
}

export async function inspectZcodeModels(
  environment: NodeJS.ProcessEnv,
): Promise<HarnessModelCatalog> {
  const source = await readFile(
    path.join(zcodeHome(environment), "v2/provider_config.json"),
    "utf8",
  );
  const root = record(JSON.parse(source));
  const config = record(root.config);
  const providerRules = Array.isArray(record(config.providerConfigRules).providerRules)
    ? (record(config.providerConfigRules).providerRules as unknown[])
    : [];
  const modelRules = Array.isArray(record(config.modelConfigRules).providerModelRules)
    ? (record(config.modelConfigRules).providerModelRules as unknown[])
    : [];
  const providerNames = new Map<string, string>();
  const providerOrder = Array.isArray(config.providerOrder)
    ? config.providerOrder.filter((value): value is string => typeof value === "string")
    : [];
  for (const entry of providerRules) {
    const row = record(entry);
    if (typeof row.providerId === "string") {
      providerNames.set(
        row.providerId,
        typeof row.providerName === "string" ? row.providerName : row.providerId,
      );
    }
  }

  const thinking = new Map<string, ReturnType<typeof harnessThinkingOptionSchema.parse>>();
  const models = modelRules.flatMap((entry) => {
    const row = record(entry);
    const rule = record(row.config);
    if (
      typeof row.providerId !== "string" ||
      typeof row.modelId !== "string" ||
      rule.enabled === false
    ) {
      return [];
    }
    const values = record(record(rule.optionSpecs).reasoningLevel).values;
    const supported = Array.isArray(values)
      ? values.flatMap((value) => {
          if (typeof value !== "string") return [];
          const option = harnessThinkingOptionSchema.safeParse({
            id: value,
            label: value === "xhigh" ? "Extra high" : `${value[0]?.toUpperCase()}${value.slice(1)}`,
          });
          if (!option.success) return [];
          thinking.set(option.data.id, option.data);
          return [option.data.id];
        })
      : [];
    const providerLabel = providerNames.get(row.providerId);
    return [
      {
        ref: zcodeModelRef({ providerId: row.providerId, modelId: row.modelId }),
        label: row.modelId,
        ...(providerLabel ? { resolvedModelLabel: `${row.modelId} (${providerLabel})` } : {}),
        ...(supported.length ? { supportedThinkingOptionIds: supported } : {}),
      },
    ];
  });
  if (!models.length) throw new Error("ZCode returned an empty configured Model catalog");
  models.sort((left, right) => {
    const l = zcodeNativeModel(left.ref);
    const r = zcodeNativeModel(right.ref);
    return (
      (providerOrder.indexOf(l.providerId) + 1 || Number.MAX_SAFE_INTEGER) -
        (providerOrder.indexOf(r.providerId) + 1 || Number.MAX_SAFE_INTEGER) ||
      l.modelId.localeCompare(r.modelId)
    );
  });
  const defaultModel = models[0]?.ref;
  const thinkingOptions = [...thinking.values()];
  const defaultThinkingOptionId = thinkingOptions.find(({ id }) => id === "max")?.id;
  return harnessModelCatalogSchema.parse({
    models,
    thinkingOptions,
    ...(defaultModel ? { defaultModel } : {}),
    ...(defaultThinkingOptionId ? { defaultThinkingOptionId } : {}),
  });
}

export function stateFromZcodeSnapshot(snapshot: unknown): HarnessSessionState {
  const value = record(snapshot);
  const settings = record(value.settings);
  const model = record(record(settings.model).current);
  const thought = record(settings.thoughtLevel);
  const mode = record(settings.mode).current;
  const availableThinkingOptions = Array.isArray(thought.available)
    ? thought.available.flatMap((entry) => {
        const option = record(entry);
        if (typeof option.value !== "string" || typeof option.label !== "string") return [];
        const parsed = harnessThinkingOptionSchema.safeParse({
          id: option.value,
          label: option.label,
        });
        return parsed.success ? [parsed.data] : [];
      })
    : undefined;
  return {
    ...(typeof model.providerId === "string" && typeof model.modelId === "string"
      ? {
          effectiveModel: zcodeModelRef({ providerId: model.providerId, modelId: model.modelId }),
          resolvedModelLabel: model.modelId,
        }
      : {}),
    ...(typeof thought.current === "string"
      ? { effectiveThinkingOptionId: harnessThinkingOptionIdSchema.parse(thought.current) }
      : {}),
    ...(availableThinkingOptions ? { availableThinkingOptions } : {}),
    ...(typeof mode === "string"
      ? { effectivePermissionModeId: harnessPermissionModeIdSchema.parse(mode) }
      : {}),
  };
}
