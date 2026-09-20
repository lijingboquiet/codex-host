import { writeFile } from "node:fs/promises";

const semverPattern =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const targetPattern = /^(?:macos|windows|linux)-(?:arm64|x64)$/u;
const repositoryPattern =
  /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})\/[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})$/u;

export const DEFAULT_RELEASE_REPOSITORY = "bytepioneer-ai/codex-host";

export function releaseRepositoryFromEnvironment(environment = process.env) {
  const repository =
    environment.CODEXHOST_RELEASE_REPOSITORY ||
    environment.GITHUB_REPOSITORY ||
    DEFAULT_RELEASE_REPOSITORY;
  if (!repositoryPattern.test(repository) || repository.endsWith(".")) {
    throw new Error("release repository must be a GitHub owner/name slug");
  }
  return repository.toLowerCase();
}

export function createDistributionMetadata({
  version,
  distribution,
  target,
  releaseRepository = DEFAULT_RELEASE_REPOSITORY,
}) {
  if (!semverPattern.test(version)) throw new Error("distribution version must be valid semver");
  if (distribution !== "installer" && distribution !== "npm") {
    throw new Error("distribution must be installer or npm");
  }
  if (!targetPattern.test(target)) throw new Error("distribution target is invalid");
  if (!repositoryPattern.test(releaseRepository) || releaseRepository.endsWith(".")) {
    throw new Error("release repository must be a GitHub owner/name slug");
  }
  return {
    schemaVersion: 1,
    version,
    distribution,
    target,
    releaseRepository: releaseRepository.toLowerCase(),
  };
}

export async function writeDistributionMetadata(filePath, options) {
  const metadata = createDistributionMetadata(options);
  await writeFile(filePath, `${JSON.stringify(metadata)}\n`, { encoding: "utf8", mode: 0o600 });
  return metadata;
}
