import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";
import { ZcodeAdapter } from "./adapter.js";

export function createHarnessAdapter(context: HarnessPluginContext): ZcodeAdapter {
  return new ZcodeAdapter({ environment: { ...context.environment } });
}
