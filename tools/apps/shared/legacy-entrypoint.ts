import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import path from "node:path";

function exitWithResult(result: SpawnSyncReturns<string>): never {
  if (result.error) {
    throw result.error;
  }
  if (result.signal) {
    process.kill(process.pid, result.signal);
  }
  process.exit(result.status ?? 1);
}

function resolveToolsRoot(): string {
  return path.resolve(import.meta.dir, "../..");
}

function resolveLegacyPath(relativePathFromToolsRoot: string): string {
  return path.join(resolveToolsRoot(), relativePathFromToolsRoot);
}

export function runLegacyTsEntrypoint(relativePathFromToolsRoot: string): never {
  const result = spawnSync(
    process.execPath,
    [resolveLegacyPath(relativePathFromToolsRoot), ...process.argv.slice(2)],
    {
      stdio: "inherit",
    }
  );
  return exitWithResult(result);
}

export function runLegacyShellEntrypoint(relativePathFromToolsRoot: string): never {
  const result = spawnSync(
    "bash",
    [resolveLegacyPath(relativePathFromToolsRoot), ...process.argv.slice(2)],
    {
      stdio: "inherit",
    }
  );
  return exitWithResult(result);
}
