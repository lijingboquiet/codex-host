import path from "node:path";
import {
  commandInvocation,
  resolveHarnessExecutable,
  targetPath,
  VERSION_MANAGER_ROOTS,
  type HarnessDiscoverySpec,
} from "@codexhost/harness-discovery";

export class TraexExecutableError extends Error {
  readonly code = "TRAEX_NOT_FOUND";
}

export const traexDiscoverySpec: HarnessDiscoverySpec = {
  id: "traex",
  command: "traex",
  commandEnvironmentVariable: "CODEXHOST_TRAEX_COMMAND",
  installRoots: {
    posix: ["~/.local/bin", VERSION_MANAGER_ROOTS, "/opt/homebrew/bin", "/usr/local/bin"],
    windows: ["${LOCALAPPDATA}/Programs/traex", "${APPDATA}/npm", VERSION_MANAGER_ROOTS],
  },
};

export function resolveTraexExecutable(
  input: {
    command?: string;
    environment?: NodeJS.ProcessEnv;
    homeDirectory?: string;
    platform?: NodeJS.Platform;
  } = {},
): string {
  const platform = input.platform ?? process.platform;
  const resolution = resolveHarnessExecutable(traexDiscoverySpec, {
    ...(input.command ? { command: input.command } : {}),
    environment: input.environment ?? process.env,
    ...(input.homeDirectory ? { homeDirectory: input.homeDirectory } : {}),
    platform,
  });
  if (!resolution) {
    throw new TraexExecutableError(
      "TraeX CLI is not installed; install traex or set CODEXHOST_TRAEX_COMMAND",
    );
  }
  return targetPath(platform).isAbsolute(resolution.executable)
    ? resolution.executable
    : path.resolve(resolution.executable);
}

export function traexInvocation(
  executable: string,
  arguments_: string[],
  environment: NodeJS.ProcessEnv,
  platform = process.platform,
) {
  return commandInvocation(executable, arguments_, environment, platform);
}
