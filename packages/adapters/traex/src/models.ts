import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type {
  HarnessModelCatalog,
  HarnessModelRef,
  HarnessModelServiceStatus,
  HarnessPermissionModeCatalog,
  HarnessSessionCapabilities,
  HarnessSessionState,
  HarnessThinkingOption,
} from "@codexhost/harness-adapter";
import {
  harnessModelCatalogSchema,
  harnessModelRefSchema,
  harnessPermissionModeCatalogSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionSchema,
} from "@codexhost/shared-contracts";
import { resolveTraexExecutable, traexInvocation } from "./command.js";

export const TRAEX_CAPABILITIES: HarnessSessionCapabilities = {
  configuration: {
    selectModel: true,
    selectThinkingOption: true,
    selectPermissionMode: true,
    permissionModeScope: "atCreate",
  },
  history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
};

export const TRAEX_PERMISSION_MODES: HarnessPermissionModeCatalog =
  harnessPermissionModeCatalogSchema.parse({
    defaultModeId: "default",
    modes: [
      {
        id: "default",
        label: "Workspace Edit",
        description: "Workspace writes are allowed; broader access asks for approval.",
      },
      {
        id: "auto",
        label: "Auto",
        description: "Workspace writes are allowed and eligible approvals use TraeX auto review.",
      },
      {
        id: "bypass_permissions",
        label: "Full Access",
        description: "Run without approval or sandbox restrictions.",
        dangerous: true,
      },
    ],
  });

export function traexModelRef(nativeId: string): HarnessModelRef {
  return harnessModelRefSchema.parse({
    id: `traex.${Buffer.from(nativeId, "utf8").toString("base64url")}`,
  });
}

export function traexNativeModel(ref: HarnessModelRef): string {
  if (!ref.id.startsWith("traex.")) throw new Error("Invalid TraeX Model Ref");
  const native = Buffer.from(ref.id.slice(6), "base64url").toString("utf8");
  if (!native || traexModelRef(native).id !== ref.id) throw new Error("Invalid TraeX Model Ref");
  return native;
}

export function traexCatalogModelRef(name: string, configName: unknown): HarnessModelRef {
  return traexModelRef(typeof configName === "string" && configName.trim() ? configName : name);
}

interface TraexModelRow {
  name?: unknown;
  config_name?: unknown;
  _meta?: unknown;
}

interface TraexDebugModel {
  slug?: unknown;
  supported_reasoning_levels?: unknown;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function percentage(value: unknown, maximum?: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  if (maximum !== undefined && value > maximum) return undefined;
  return value;
}

function nonNegativeSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function traexModelServiceStatus(row: unknown): HarnessModelServiceStatus | undefined {
  const trae = record(record(record(row)._meta).trae);
  const loadPercent = percentage(record(trae.load).percent);
  const quota = record(trae.weeklyQuota);
  const usedPercent = percentage(quota.usedPercent, 100);
  const remainingPercent = percentage(quota.remainingPercent, 100);
  const resetsAtUnix = nonNegativeSafeInteger(quota.resetTime);
  const weeklyQuota =
    quota.applies === true &&
    typeof quota.isDepleted === "boolean" &&
    usedPercent !== undefined &&
    remainingPercent !== undefined
      ? {
          usedPercent,
          remainingPercent,
          depleted: quota.isDepleted,
          ...(resetsAtUnix !== undefined ? { resetsAtUnix } : {}),
        }
      : undefined;
  if (loadPercent === undefined && weeklyQuota === undefined) return undefined;
  return {
    ...(loadPercent !== undefined ? { loadPercent } : {}),
    ...(weeklyQuota ? { weeklyQuota } : {}),
  };
}

function runJson(
  executable: string,
  arguments_: string[],
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const invocation = traexInvocation(executable, arguments_, environment);
    const child = spawn(invocation.command, invocation.arguments, {
      env: environment,
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("TraeX model catalog probe timed out"));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 64_000_000) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-2_000);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`TraeX model catalog probe exited (${code}): ${stderr.trim()}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error("TraeX model catalog probe returned invalid JSON"));
      }
    });
  });
}

async function configuredDefaults(environment: NodeJS.ProcessEnv) {
  const home = environment.TRAE_HOME ?? path.join(environment.HOME ?? os.homedir(), ".trae");
  const source = await readFile(path.join(home, "traecli.toml"), "utf8").catch(() => "");
  const value = (key: string) => {
    const match = new RegExp(`^${key}\\s*=\\s*[\"']([^\"']+)[\"']\\s*(?:#.*)?$`, "mu").exec(source);
    return match?.[1];
  };
  return { model: value("model"), thinking: value("model_reasoning_effort") };
}

export async function inspectTraexModels(options: {
  command?: string;
  environment: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<HarnessModelCatalog> {
  const executable = resolveTraexExecutable(options);
  const timeout = options.timeoutMs ?? 20_000;
  const [listed, debugged, defaults] = await Promise.all([
    runJson(executable, ["models", "--json"], options.environment, timeout),
    runJson(executable, ["debug", "models"], options.environment, timeout),
    configuredDefaults(options.environment),
  ]);
  if (!Array.isArray(listed)) throw new Error("TraeX returned no model catalog");
  const debugRows = Array.isArray(record(debugged).models)
    ? (record(debugged).models as TraexDebugModel[])
    : [];
  const debugBySlug = new Map(
    debugRows.flatMap((row) => (typeof row.slug === "string" ? [[row.slug, row] as const] : [])),
  );
  const thinking = new Map<string, HarnessThinkingOption>();
  const models = (listed as TraexModelRow[]).flatMap((row) => {
    if (typeof row.name !== "string" || !row.name.trim()) return [];
    const detail = debugBySlug.get(row.name);
    const supported = Array.isArray(detail?.supported_reasoning_levels)
      ? detail.supported_reasoning_levels.flatMap((entry) => {
          const item = record(entry);
          if (typeof item.effort !== "string") return [];
          const option = harnessThinkingOptionSchema.safeParse({
            id: item.effort,
            label:
              item.effort === "xhigh"
                ? "Extra high"
                : `${item.effort[0]?.toUpperCase()}${item.effort.slice(1)}`,
          });
          if (!option.success) return [];
          thinking.set(option.data.id, option.data);
          return [option.data.id];
        })
      : [];
    const serviceStatus = traexModelServiceStatus(row);
    return [
      {
        ref: traexCatalogModelRef(row.name, row.config_name),
        label: row.name,
        ...(supported.length ? { supportedThinkingOptionIds: supported } : {}),
        ...(serviceStatus ? { serviceStatus } : {}),
      },
    ];
  });
  if (!models.length) throw new Error("TraeX returned an empty model catalog");
  const defaultEntry = models.find(({ ref, label }) => {
    if (!defaults.model) return false;
    return ref.id === traexModelRef(defaults.model).id || label === defaults.model;
  });
  const thinkingOptions = [...thinking.values()];
  const defaultThinking = thinkingOptions.find(({ id }) => id === defaults.thinking);
  return harnessModelCatalogSchema.parse({
    models,
    thinkingOptions,
    ...(defaultEntry ? { defaultModel: defaultEntry.ref } : {}),
    ...(defaultThinking ? { defaultThinkingOptionId: defaultThinking.id } : {}),
  });
}

function selectOptions(options: SessionConfigOption[] | undefined, id: string) {
  const option = options?.find((candidate) => candidate.id === id);
  if (!option || option.type !== "select") throw new Error(`TraeX ACP omitted ${id}`);
  return {
    current: option.currentValue,
    choices: option.options.flatMap((entry) => ("value" in entry ? [entry] : entry.options)),
  };
}

export function traexConfiguration(
  options: SessionConfigOption[] | undefined,
  permissionModeId: string,
): { state: HarnessSessionState; modelIds: Set<string>; thinkingIds: Set<string> } {
  const models = selectOptions(options, "model");
  const thinking = selectOptions(options, "reasoning_effort");
  const currentModel = models.choices.find(({ value }) => value === models.current);
  const currentThinking = thinking.choices.find(({ value }) => value === thinking.current);
  if (!currentModel || !currentThinking)
    throw new Error("TraeX ACP returned invalid configuration");
  const availableThinkingOptions = thinking.choices.map(({ value, name }) =>
    harnessThinkingOptionSchema.parse({ id: value, label: name }),
  );
  return {
    state: {
      effectiveModel: traexModelRef(currentModel.value),
      resolvedModelLabel: currentModel.name,
      effectiveThinkingOptionId: harnessThinkingOptionSchema.parse({
        id: currentThinking.value,
        label: currentThinking.name,
      }).id,
      availableThinkingOptions,
      effectivePermissionModeId: harnessPermissionModeIdSchema.parse(permissionModeId),
    },
    modelIds: new Set(models.choices.map(({ value }) => value)),
    thinkingIds: new Set(thinking.choices.map(({ value }) => value)),
  };
}
