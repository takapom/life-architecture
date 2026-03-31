import path from "node:path";

import {
  ensureManagedRustToolBinary,
  resolveManagedRustToolBinaryPath,
  resolveRustToolTargetDir,
} from "../../adapters/rust-runtime";

const defaultRepoRoot = path.resolve(import.meta.dir, "../../..");

export function resolveOrchestratorBinaryPath(
  repoRoot = defaultRepoRoot,
  targetDir = resolveRustToolTargetDir({
    repoRoot,
    toolId: "orchestrator",
  })
): string {
  return resolveManagedRustToolBinaryPath({
    profile: "debug",
    repoRoot,
    targetDir,
    toolId: "orchestrator",
  });
}

export function ensureOrchestratorBinary(options?: {
  binaryPath?: string;
  repoRoot?: string;
  sourcePaths?: readonly string[];
  targetDir?: string;
}): string {
  const repoRoot = options?.repoRoot ?? defaultRepoRoot;
  const targetDir =
    options?.targetDir ??
    resolveRustToolTargetDir({
      repoRoot,
      toolId: "orchestrator",
    });
  return ensureManagedRustToolBinary({
    binaryPath: options?.binaryPath ?? resolveOrchestratorBinaryPath(repoRoot, targetDir),
    repoRoot,
    sourcePaths: options?.sourcePaths,
    targetDir,
    toolId: "orchestrator",
  });
}
