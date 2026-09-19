import path from "node:path";
import {
  commandInvocation,
  resolveHarnessExecutable,
  targetPath,
  VERSION_MANAGER_ROOTS,
  type CommandInvocation,
  type HarnessDiscoverySpec,
} from "@codexhost/harness-discovery";

export class ZcodeExecutableError extends Error {
  readonly code = "ZCODE_NOT_FOUND";
}

export const zcodeDiscoverySpec: HarnessDiscoverySpec = {
  id: "zcode",
  command: "zcode",
  commandEnvironmentVariable: "CODEXHOST_ZCODE_COMMAND",
  installRoots: {
    posix: [
      "/Applications/ZCode.app/Contents/Resources/glm",
      "~/.local/bin",
      VERSION_MANAGER_ROOTS,
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ],
    windows: [
      "${LOCALAPPDATA}/Programs/ZCode/resources/glm",
      "${LOCALAPPDATA}/Programs/zcode",
      "${APPDATA}/npm",
      VERSION_MANAGER_ROOTS,
    ],
  },
  runnableCandidate(candidate, context) {
    if (context.isExecutable(candidate)) return candidate;
    const cjs = `${candidate}.cjs`;
    return context.isExecutable(cjs) ? cjs : undefined;
  },
};

export function resolveZcodeExecutable(
  input: {
    command?: string;
    environment?: NodeJS.ProcessEnv;
    homeDirectory?: string;
    platform?: NodeJS.Platform;
  } = {},
): string {
  const platform = input.platform ?? process.platform;
  const resolution = resolveHarnessExecutable(zcodeDiscoverySpec, {
    ...(input.command ? { command: input.command } : {}),
    environment: input.environment ?? process.env,
    ...(input.homeDirectory ? { homeDirectory: input.homeDirectory } : {}),
    platform,
  });
  if (!resolution) {
    throw new ZcodeExecutableError(
      "ZCode CLI is not installed; install ZCode or set CODEXHOST_ZCODE_COMMAND",
    );
  }
  return targetPath(platform).isAbsolute(resolution.executable)
    ? resolution.executable
    : path.resolve(resolution.executable);
}

export function zcodeInvocation(
  executable: string,
  arguments_: string[],
  environment: NodeJS.ProcessEnv,
  platform = process.platform,
): CommandInvocation {
  if (/\.[cm]?js$/iu.test(executable)) {
    return commandInvocation(process.execPath, [executable, ...arguments_], environment, platform);
  }
  return commandInvocation(executable, arguments_, environment, platform);
}
