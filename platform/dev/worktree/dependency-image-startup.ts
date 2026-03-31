#!/usr/bin/env bun

import {
  chmodSync,
  cpSync,
  type Dirent,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { resolveRepoRoot } from "../../../tools/adapters/cli";
import { readWorkspacePatterns } from "../../../tools/adapters/root-workspace";
import {
  CANONICAL_BUN_INSTALL_FLAGS,
  DEPENDENCY_IMAGE_ATTACH_MODE_SHARED_READ_ONLY,
  DEPENDENCY_IMAGE_ATTACH_SCHEMA_VERSION,
  type DependencyImageAttachState,
  resolveDependencyImageAttachStatePath,
} from "../shared/dependency-image-attach-guard";
import {
  DEFAULT_DEPENDENCY_IMAGE_LEASE_POLL_INTERVAL_MS,
  DEFAULT_DEPENDENCY_IMAGE_LEASE_STALE_AFTER_MS,
  DEFAULT_DEPENDENCY_IMAGE_LEASE_WAIT_TIMEOUT_MS,
  type EnsureDependencyImageResult,
  ensureDependencyImage,
  resolveDependencyImageRoot,
} from "../shared/dependency-image-cache";
import { buildDependencyImageIdentity } from "../shared/dependency-image-identity";

export type AttachStartupDependencyImageOptions = {
  repoRoot: string;
  sourceWorktreePath: string;
  targetWorktreePath: string;
};

export type AttachStartupDependencyImageResult = EnsureDependencyImageResult & {
  attachState: DependencyImageAttachState;
  attachStatePath: string;
  materializedNodeModulesPaths: string[];
};

type CopyRecursiveOptions = {
  recursive?: boolean;
  verbatimSymlinks?: boolean;
};

type CopyRecursiveImplementation = (
  sourcePath: string,
  targetPath: string,
  options: CopyRecursiveOptions
) => void;

type CliOptions = {
  command: "bootstrap" | "state-path";
  repoRoot: string;
  sourceWorktreePath: string;
  targetWorktreePath: string;
};

const MAX_RUNTIME_COPY_ATTEMPTS = 2;
const MAX_RUNTIME_IMAGE_REBUILD_ATTEMPTS = 3;
const STARTUP_DEPENDENCY_IMAGE_WAIT_TIMEOUT_MS = DEFAULT_DEPENDENCY_IMAGE_LEASE_WAIT_TIMEOUT_MS;
const STARTUP_DEPENDENCY_IMAGE_STALE_AFTER_MS = DEFAULT_DEPENDENCY_IMAGE_LEASE_STALE_AFTER_MS;
const STARTUP_DEPENDENCY_IMAGE_POLL_INTERVAL_MS = DEFAULT_DEPENDENCY_IMAGE_LEASE_POLL_INTERVAL_MS;
let copyRuntimePathRecursive: CopyRecursiveImplementation = cpSync;

function fail(message: string): never {
  process.stderr.write(`[dependency-image-startup] ERROR: ${message}\n`);
  process.exit(1);
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function isRetryableRuntimeCopyError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return false;
  }
  return error.code === "ENOENT" || error.code === "EEXIST" || error.code === "EINVAL";
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function toRuntimeMaterializationError(relativePath: string, error: unknown): Error {
  return new Error(
    `[dependency-image-startup] runtime materialization failed for ${relativePath}: ${formatErrorMessage(error)}`,
    { cause: error }
  );
}

function usage(): string {
  return `Usage:
  bun platform/dev/worktree/dependency-image-startup.ts bootstrap --source-worktree <path> --target-worktree <path> [--repo-root <path>]
  bun platform/dev/worktree/dependency-image-startup.ts state-path --target-worktree <path>`;
}

function parseArgs(argv: string[]): CliOptions {
  const command = String(argv[0] || "").trim() as CliOptions["command"];
  let repoRoot = "";
  let sourceWorktreePath = "";
  let targetWorktreePath = "";

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--repo-root":
        repoRoot = String(argv[index + 1] || "").trim();
        index += 1;
        break;
      case "--source-worktree":
        sourceWorktreePath = String(argv[index + 1] || "").trim();
        index += 1;
        break;
      case "--target-worktree":
        targetWorktreePath = String(argv[index + 1] || "").trim();
        index += 1;
        break;
      case "--help":
      case "-h":
        process.stdout.write(`${usage()}\n`);
        process.exit(0);
        break;
      default:
        fail(`unknown argument: ${arg}`);
    }
  }

  if (command !== "bootstrap" && command !== "state-path") {
    fail(usage());
  }
  if (!targetWorktreePath) {
    fail("--target-worktree is required");
  }
  if (command === "bootstrap" && !sourceWorktreePath) {
    fail("--source-worktree is required for bootstrap");
  }

  return {
    command,
    repoRoot: path.resolve(repoRoot || resolveRepoRoot()),
    sourceWorktreePath: path.resolve(sourceWorktreePath || "."),
    targetWorktreePath: path.resolve(targetWorktreePath),
  };
}

function ensureDirectory(targetPath: string): string {
  mkdirSync(targetPath, { recursive: true });
  return targetPath;
}

function pathExistsIncludingSymlink(targetPath: string): boolean {
  try {
    lstatSync(targetPath);
    return true;
  } catch {
    return false;
  }
}

function ensureNodeModulesDirectory(sourceWorktreePath: string, relativePath: string): string {
  const nodeModulesPath = path.join(sourceWorktreePath, relativePath);
  if (!existsSync(nodeModulesPath)) {
    throw new Error(
      `[dependency-image-startup] source worktree runtime is missing node_modules: ${path.join(sourceWorktreePath, relativePath)}`
    );
  }
  const nodeModulesStats = lstatSync(nodeModulesPath);
  if (!nodeModulesStats.isDirectory() && !nodeModulesStats.isSymbolicLink()) {
    throw new Error(
      `[dependency-image-startup] source node_modules is not a directory or symlink: ${nodeModulesPath}`
    );
  }
  return nodeModulesPath;
}

function listWorkspacePackageDirs(repoRoot: string): string[] {
  const results: string[] = [];
  for (const workspaceGlob of readWorkspacePatterns(repoRoot)) {
    if (!workspaceGlob.endsWith("/*")) {
      throw new Error(
        `[dependency-image-startup] unsupported workspace glob "${workspaceGlob}"; expected "segment/*"`
      );
    }

    const segment = workspaceGlob.slice(0, -2);
    const segmentDir = path.join(repoRoot, segment);
    if (!existsSync(segmentDir)) {
      continue;
    }

    for (const entry of readdirSync(segmentDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const packageDir = path.join(segmentDir, entry.name);
      if (existsSync(path.join(packageDir, "package.json"))) {
        results.push(packageDir);
      }
    }
  }

  return [...new Set(results)].sort((left, right) => left.localeCompare(right));
}

function collectMaterializedNodeModulesPaths(sourceWorktreePath: string): string[] {
  const results = ["node_modules"];
  for (const workspaceDir of listWorkspacePackageDirs(sourceWorktreePath)) {
    const relativeNodeModulesPath = path
      .join(path.relative(sourceWorktreePath, workspaceDir), "node_modules")
      .replace(/\\/g, "/");
    if (existsSync(path.join(sourceWorktreePath, relativeNodeModulesPath))) {
      results.push(relativeNodeModulesPath);
    }
  }
  return results;
}

function makeReadOnlyRecursive(targetPath: string): void {
  const stats = lstatSync(targetPath);
  if (stats.isSymbolicLink()) {
    return;
  }

  const nextMode = stats.isDirectory() ? 0o555 : stats.mode & ~0o222;
  chmodSync(targetPath, nextMode);
  if (!stats.isDirectory()) {
    return;
  }

  for (const entry of readdirSync(targetPath, { withFileTypes: true })) {
    makeReadOnlyRecursive(path.join(targetPath, entry.name));
  }
}

function makeWritableForReplacement(targetPath: string): void {
  if (!existsSync(targetPath)) {
    return;
  }

  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(targetPath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return;
    }
    throw error;
  }
  if (stats.isSymbolicLink()) {
    return;
  }

  if (stats.isDirectory()) {
    try {
      chmodSync(targetPath, 0o755);
    } catch (error) {
      if (isMissingPathError(error)) {
        return;
      }
      throw error;
    }
    let entries: Dirent[];
    try {
      entries = readdirSync(targetPath, { withFileTypes: true });
    } catch (error) {
      if (isMissingPathError(error)) {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      makeWritableForReplacement(path.join(targetPath, entry.name));
    }
    return;
  }

  try {
    chmodSync(targetPath, stats.mode | 0o200);
  } catch (error) {
    if (isMissingPathError(error)) {
      return;
    }
    throw error;
  }
}

function rewriteTargetWorkspaceState(
  _sourceWorktreePath: string,
  _targetWorktreePath: string,
  _targetRootNodeModulesPath: string
): void {
  // Bun hoisted installs do not rely on workspace-state metadata rewrites.
}

function rewriteTargetBinShimPaths(
  sourceWorktreePath: string,
  targetWorktreePath: string,
  targetNodeModulesPath: string
): void {
  const binDirPath = path.join(targetNodeModulesPath, ".bin");
  if (!existsSync(binDirPath)) {
    return;
  }

  for (const entry of readdirSync(binDirPath, { withFileTypes: true })) {
    const entryPath = path.join(binDirPath, entry.name);
    if (!entry.isFile()) {
      continue;
    }

    const raw = readFileSync(entryPath, "utf8");
    const rewritten = raw.split(sourceWorktreePath).join(targetWorktreePath);
    if (rewritten !== raw) {
      writeFileSync(entryPath, rewritten, "utf8");
    }
  }
}

function syncSymlinkTargetsFromSource(sourcePath: string, targetPath: string): void {
  if (!pathExistsIncludingSymlink(sourcePath) || !pathExistsIncludingSymlink(targetPath)) {
    return;
  }

  const sourceStats = lstatSync(sourcePath);
  const targetStats = lstatSync(targetPath);

  if (sourceStats.isSymbolicLink()) {
    const sourceLinkTarget = readlinkSync(sourcePath);
    if (!targetStats.isSymbolicLink() || readlinkSync(targetPath) !== sourceLinkTarget) {
      rmSync(targetPath, { force: true, recursive: true });
      symlinkSync(sourceLinkTarget, targetPath);
    }
    return;
  }

  if (!sourceStats.isDirectory() || !targetStats.isDirectory()) {
    return;
  }

  for (const entry of readdirSync(sourcePath, { withFileTypes: true })) {
    syncSymlinkTargetsFromSource(
      path.join(sourcePath, entry.name),
      path.join(targetPath, entry.name)
    );
  }
}

function resetTargetPath(targetPath: string): void {
  makeWritableForReplacement(targetPath);
  rmSync(targetPath, { force: true, recursive: true });
}

function materializeRuntimePath(
  imageRoot: string,
  sourceWorktreePath: string,
  targetWorktreePath: string,
  relativePath: string
): void {
  const sourcePath = path.join(imageRoot, relativePath);
  const sourceRuntimePath = path.join(sourceWorktreePath, relativePath);
  const targetPath = path.join(targetWorktreePath, relativePath);

  for (let attempt = 0; attempt < MAX_RUNTIME_COPY_ATTEMPTS; attempt += 1) {
    resetTargetPath(targetPath);
    ensureDirectory(path.dirname(targetPath));

    try {
      copyRuntimePathRecursive(sourcePath, targetPath, {
        recursive: true,
        verbatimSymlinks: true,
      });
      syncSymlinkTargetsFromSource(sourceRuntimePath, targetPath);
      return;
    } catch (error) {
      resetTargetPath(targetPath);
      if (!isRetryableRuntimeCopyError(error) || attempt >= MAX_RUNTIME_COPY_ATTEMPTS - 1) {
        throw toRuntimeMaterializationError(relativePath, error);
      }
    }
  }
}

function materializePublishedImageRuntime(
  imageRoot: string,
  sourceWorktreePath: string,
  targetWorktreePath: string,
  materializedNodeModulesPaths: string[]
): string[] {
  const materializedPaths: string[] = [];
  let currentRelativePath = "";

  try {
    for (const relativePath of materializedNodeModulesPaths) {
      currentRelativePath = relativePath;
      materializeRuntimePath(imageRoot, sourceWorktreePath, targetWorktreePath, relativePath);
      rewriteTargetBinShimPaths(
        sourceWorktreePath,
        targetWorktreePath,
        path.join(targetWorktreePath, relativePath)
      );
      materializedPaths.push(relativePath);
      currentRelativePath = "";
    }

    rewriteTargetWorkspaceState(
      sourceWorktreePath,
      targetWorktreePath,
      path.join(targetWorktreePath, "node_modules")
    );

    for (const relativePath of materializedPaths) {
      makeReadOnlyRecursive(path.join(targetWorktreePath, relativePath));
    }

    return materializedPaths;
  } catch (error) {
    const cleanupPaths = currentRelativePath
      ? [...new Set([...materializedPaths, currentRelativePath])]
      : materializedPaths;
    for (const relativePath of cleanupPaths) {
      resetTargetPath(path.join(targetWorktreePath, relativePath));
    }
    throw error;
  }
}

function invalidateIncompletePublishedImage(
  imageRoot: string,
  materializedNodeModulesPaths: string[]
): void {
  if (!existsSync(imageRoot)) {
    return;
  }
  for (const relativePath of materializedNodeModulesPaths) {
    if (!existsSync(path.join(imageRoot, relativePath))) {
      rmSync(imageRoot, { force: true, recursive: true });
      return;
    }
  }
}

export async function attachStartupDependencyImage(
  options: AttachStartupDependencyImageOptions
): Promise<AttachStartupDependencyImageResult> {
  const repoRoot = path.resolve(options.repoRoot);
  const sourceWorktreePath = path.resolve(options.sourceWorktreePath);
  const targetWorktreePath = path.resolve(options.targetWorktreePath);
  const materializedNodeModulesPaths = collectMaterializedNodeModulesPaths(sourceWorktreePath);

  for (const relativePath of materializedNodeModulesPaths) {
    ensureNodeModulesDirectory(sourceWorktreePath, relativePath);
  }

  const identity = buildDependencyImageIdentity({
    installFlags: CANONICAL_BUN_INSTALL_FLAGS,
    packageManager: "bun",
    repoRoot,
  });

  const imageRoot = resolveDependencyImageRoot(repoRoot, identity.depImageId);
  let lastError: unknown = null;

  for (let attempt = 0; attempt < MAX_RUNTIME_IMAGE_REBUILD_ATTEMPTS; attempt += 1) {
    invalidateIncompletePublishedImage(imageRoot, materializedNodeModulesPaths);

    const ensureResult = await ensureDependencyImage({
      repoRoot,
      depImageId: identity.depImageId,
      lease: {
        owner: {
          operation: "dependency-image-startup.bootstrap",
          sourceWorktreePath,
          targetWorktreePath,
        },
        pollIntervalMs: STARTUP_DEPENDENCY_IMAGE_POLL_INTERVAL_MS,
        staleAfterMs: STARTUP_DEPENDENCY_IMAGE_STALE_AFTER_MS,
        waitTimeoutMs: STARTUP_DEPENDENCY_IMAGE_WAIT_TIMEOUT_MS,
      },
      build(draftRoot) {
        ensureDirectory(draftRoot);
        for (const relativePath of materializedNodeModulesPaths) {
          ensureDirectory(path.dirname(path.join(draftRoot, relativePath)));
          cpSync(path.join(sourceWorktreePath, relativePath), path.join(draftRoot, relativePath), {
            recursive: true,
            verbatimSymlinks: true,
          });
        }
      },
      verify(draftRoot) {
        if (!existsSync(path.join(draftRoot, "node_modules"))) {
          throw new Error(
            `[dependency-image-startup] published dependency image is missing node_modules: ${draftRoot}`
          );
        }
      },
    });

    try {
      const materializedPaths = materializePublishedImageRuntime(
        ensureResult.record.imageRoot,
        sourceWorktreePath,
        targetWorktreePath,
        materializedNodeModulesPaths
      );

      const attachState: DependencyImageAttachState = {
        attachMode: DEPENDENCY_IMAGE_ATTACH_MODE_SHARED_READ_ONLY,
        depImageId: identity.depImageId,
        imageNodeModulesPath: ensureResult.record.nodeModulesPath,
        imageRoot: ensureResult.record.imageRoot,
        materializedNodeModulesPaths,
        schemaVersion: DEPENDENCY_IMAGE_ATTACH_SCHEMA_VERSION,
        sourceWorktreePath,
        targetWorktreePath,
      };
      const attachStatePath = resolveDependencyImageAttachStatePath(targetWorktreePath);
      ensureDirectory(path.dirname(attachStatePath));
      writeFileSync(attachStatePath, `${JSON.stringify(attachState, null, 2)}\n`, "utf8");

      return {
        ...ensureResult,
        attachState,
        attachStatePath,
        materializedNodeModulesPaths: materializedPaths,
      };
    } catch (error) {
      lastError = error;
      if (
        !isRetryableRuntimeCopyError(error instanceof Error ? error.cause : null) ||
        attempt >= MAX_RUNTIME_IMAGE_REBUILD_ATTEMPTS - 1
      ) {
        throw error;
      }
      rmSync(ensureResult.record.imageRoot, { force: true, recursive: true });
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("[dependency-image-startup] runtime materialization failed");
}

export function assertAttachedDependencyImageState(
  worktreePath: string
): DependencyImageAttachState {
  const statePath = resolveDependencyImageAttachStatePath(worktreePath);
  if (!existsSync(statePath)) {
    throw new Error(
      `[dependency-image-startup] missing dependency-image attach state for ${path.resolve(worktreePath)}`
    );
  }
  return JSON.parse(readFileSync(statePath, "utf8")) as DependencyImageAttachState;
}

export function setCopyRuntimePathRecursiveForTest(
  implementation: CopyRecursiveImplementation | null
): void {
  copyRuntimePathRecursive = implementation ?? cpSync;
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  if (cli.command === "state-path") {
    process.stdout.write(`${resolveDependencyImageAttachStatePath(cli.targetWorktreePath)}\n`);
    return;
  }

  const result = await attachStartupDependencyImage({
    repoRoot: cli.repoRoot,
    sourceWorktreePath: cli.sourceWorktreePath,
    targetWorktreePath: cli.targetWorktreePath,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.main) {
  await main();
}
