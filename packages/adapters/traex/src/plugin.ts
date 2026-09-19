import type { HarnessAdapter } from "@codexhost/harness-adapter";
import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";
import { BrokeredHarnessAdapter } from "@codexhost/harness-broker";
import { TraexAdapter } from "./adapter.js";

export function createHarnessAdapter(context: HarnessPluginContext): HarnessAdapter {
  if (context.platform === "darwin" && context.managedRemoteHost) {
    return new BrokeredHarnessAdapter({
      harnessId: "traex",
      forwardDelegationEnvironment: true,
      environment: { ...context.environment },
    });
  }
  return new TraexAdapter({ environment: { ...context.environment } });
}
