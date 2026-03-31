#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";

import { resolveRepoRoot } from "../../../tools/adapters/cli";
import {
  classifyTaskIssueSourceError,
  collectSafeAutoCleanupPaths as collectSafeAutoCleanupPathsFromRepoctl,
} from "../../../tools/repoctl/task-pr-steady-state";
import { listRegisteredSiblingTaskWorktreeStates } from "./sibling-task-worktrees";
import { resolveCanonicalTaskRootFromRepoRoot } from "./task-pr-steady-state";

type CliOptions = {
  apply: boolean;
  repoRoot: string;
  sourcePath: string;
};

type SafeAutoCleanupPlanningDependencies = {
  collectSafeAutoCleanupPaths: typeof collectSafeAutoCleanupPathsFromRepoctl;
};

const DEFAULT_SAFE_AUTO_CLEANUP_PLANNING_DEPENDENCIES: SafeAutoCleanupPlanningDependencies = {
  collectSafeAutoCleanupPaths: collectSafeAutoCleanupPathsFromRepoctl,
};

function usage(): string {
  return `Usage: bun run wt:cleanup:stale-task-worktrees [--repo-root <path>] [--source <path>] [--apply]

Delete safe auto-cleanup sibling task worktrees: clean task worktrees with zero unique commits against origin/main and no relevant file updates in the last 10 minutes. Default is dry-run.`;
}

function fail(message: string): never {
  process.stderr.write(`[prune-stale-task-worktrees] ERROR: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv: string[]): CliOptions {
  let repoRoot = "";
  let apply = false;
  let sourcePath = "";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--repo-root":
        repoRoot = argv[index + 1] ?? "";
        if (!repoRoot) {
          fail("missing value for --repo-root");
        }
        index += 1;
        break;
      case "--apply":
        apply = true;
        break;
      case "--source":
        sourcePath = argv[index + 1] ?? "";
        if (!sourcePath) {
          fail("missing value for --source");
        }
        index += 1;
        break;
      case "--help":
      case "-h":
        process.stdout.write(`${usage()}\n`);
        process.exit(0);
        return { apply: false, repoRoot: "", sourcePath: "" };
      default:
        fail(`unknown option: ${arg}`);
    }
  }

  return {
    apply,
    repoRoot: path.resolve(repoRoot || resolveRepoRoot()),
    sourcePath: sourcePath.trim(),
  };
}

function resolveSiblingWtRoot(repoRoot: string): string {
  return resolveCanonicalTaskRootFromRepoRoot(repoRoot);
}

export function parseGithubRepositoryFromOriginUrl(originUrl: string): string {
  const sshMatch = originUrl.match(/^git@github\.com:([^/\s]+\/[^/\s]+?)(?:\.git)?$/);
  if (sshMatch?.[1]) {
    return sshMatch[1];
  }
  const sshUrlMatch = originUrl.match(/^ssh:\/\/git@github\.com\/([^/\s]+\/[^/\s]+?)(?:\.git)?$/);
  if (sshUrlMatch?.[1]) {
    return sshUrlMatch[1];
  }
  const httpsMatch = originUrl.match(/^https:\/\/github\.com\/([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/);
  return httpsMatch?.[1] ?? "";
}

export async function collectSafeAutoCleanupPaths(
  options: { repoRoot: string; repository: string; sourcePath?: string },
  dependencies: SafeAutoCleanupPlanningDependencies = DEFAULT_SAFE_AUTO_CLEANUP_PLANNING_DEPENDENCIES
): Promise<string[]> {
  try {
    return await dependencies.collectSafeAutoCleanupPaths(options);
  } catch (error) {
    const sourceError = classifyTaskIssueSourceError(error);
    if (sourceError) {
      return [];
    }
    throw error;
  }
}

function resolveRepositoryFromOrigin(repoRoot: string): string {
  const result = spawnSync("git", ["-C", repoRoot, "remote", "get-url", "origin"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    fail(
      `failed to resolve origin repository: ${String(result.stderr || result.stdout || "").trim() || `exit=${result.status}`}`
    );
  }
  const originUrl = String(result.stdout || "").trim();
  const repository = parseGithubRepositoryFromOriginUrl(originUrl);
  if (!repository) {
    fail(`unsupported GitHub origin URL: ${originUrl}`);
  }
  return repository;
}

function runGit(repoRoot: string, args: string[]): void {
  const result = spawnSync("git", ["-C", repoRoot, ...args], {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function renderArchiveTimestamp(now = new Date()): string {
  return now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

export function archiveSafeAutoCleanupResiduePath(
  siblingWtRoot: string,
  residuePath: string,
  now = new Date()
): string {
  const archiveRoot = path.join(siblingWtRoot, "_dead-wt-archive", renderArchiveTimestamp(now));
  const archivePath = path.join(archiveRoot, path.basename(path.resolve(residuePath)));
  mkdirSync(archiveRoot, { recursive: true });
  renameSync(residuePath, archivePath);
  return archivePath;
}

function cleanupMaterializedDependencies(repoRoot: string, worktreePath: string): void {
  const helperPath = path.join(repoRoot, "platform/dev/worktree/dependency-materialization.sh");
  const result = spawnSync(
    "bash",
    [helperPath, "cleanup", "--repo-root", repoRoot, "--worktree", worktreePath],
    { stdio: "inherit" }
  );
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function localBranchExists(repoRoot: string, branch: string): boolean {
  if (!branch) {
    return false;
  }
  return (
    (spawnSync("git", ["-C", repoRoot, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
      stdio: "ignore",
    }).status ?? 1) === 0
  );
}

export function cleanupBranchScopedTaskMetadata(repoRoot: string, branch: string): string[] {
  const normalizedBranch = String(branch || "").trim();
  if (!normalizedBranch) {
    return [];
  }
  const omtaRoot = path.join(repoRoot, ".git", "omta");
  const targets = [
    path.join(omtaRoot, "task-issue-snapshots", `${normalizedBranch}.json`),
    path.join(omtaRoot, "task-issue-sources", `${normalizedBranch}.json`),
    path.join(omtaRoot, "task-issue-sources", normalizedBranch),
    path.join(omtaRoot, "task-scope-manifests", normalizedBranch),
  ];
  const removed: string[] = [];
  for (const targetPath of targets) {
    if (!existsSync(targetPath)) {
      continue;
    }
    rmSync(targetPath, { force: true, recursive: true });
    removed.push(targetPath);
  }
  return removed;
}

function garbageCollectSharedDependencyImages(repoRoot: string): void {
  const helperPath = path.join(repoRoot, "platform/dev/worktree/dependency-materialization.sh");
  const result = spawnSync("bash", [helperPath, "gc-shared-images", "--repo-root", repoRoot], {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const siblingWtRoot = resolveSiblingWtRoot(options.repoRoot);
  const repository = resolveRepositoryFromOrigin(options.repoRoot);
  const states = listRegisteredSiblingTaskWorktreeStates({
    currentRepoRoot: options.repoRoot,
    siblingWtRoot,
  });
  const safeAutoCleanupPaths = new Set(
    await collectSafeAutoCleanupPaths({
      repoRoot: options.repoRoot,
      repository,
      sourcePath: options.sourcePath || undefined,
    })
  );
  const stale = states.filter((state) => safeAutoCleanupPaths.has(state.path));
  const registeredPaths = new Set(states.map((state) => state.path));
  const deadResidue = [...safeAutoCleanupPaths]
    .filter((entryPath) => !registeredPaths.has(entryPath))
    .filter((entryPath) => existsSync(entryPath))
    .sort((left, right) => left.localeCompare(right));

  if (stale.length === 0 && deadResidue.length === 0) {
    process.stdout.write(
      "[prune-stale-task-worktrees] no safe auto-cleanup sibling task worktrees found\n"
    );
    return;
  }

  if (!options.apply) {
    process.stdout.write(
      "[prune-stale-task-worktrees] dry-run safe auto-cleanup sibling task worktrees:\n"
    );
    for (const state of stale) {
      process.stdout.write(
        `- ${state.path} | branch=${state.branch} | unique_commits=${state.uniqueCommitsAgainstOriginMain}\n`
      );
    }
    for (const residuePath of deadResidue) {
      process.stdout.write(`- ${residuePath} | action=archive-dead-residue\n`);
    }
    return;
  }

  for (const state of stale) {
    process.stdout.write(`[prune-stale-task-worktrees] removing ${state.path}\n`);
    if (existsSync(state.path)) {
      cleanupMaterializedDependencies(options.repoRoot, state.path);
      runGit(options.repoRoot, ["worktree", "remove", state.path]);
    } else {
      runGit(options.repoRoot, ["worktree", "remove", "-f", "-f", state.path]);
      runGit(options.repoRoot, ["worktree", "prune", "--expire", "now"]);
    }
    if (state.branch.startsWith("task/") && localBranchExists(options.repoRoot, state.branch)) {
      process.stdout.write(`[prune-stale-task-worktrees] deleting local branch ${state.branch}\n`);
      runGit(options.repoRoot, ["branch", "-D", state.branch]);
    }
    for (const metadataPath of cleanupBranchScopedTaskMetadata(options.repoRoot, state.branch)) {
      process.stdout.write(
        `[prune-stale-task-worktrees] removed orphaned task metadata ${metadataPath}\n`
      );
    }
  }
  for (const residuePath of deadResidue) {
    const archivePath = archiveSafeAutoCleanupResiduePath(siblingWtRoot, residuePath);
    process.stdout.write(
      `[prune-stale-task-worktrees] archived dead residue ${residuePath} -> ${archivePath}\n`
    );
  }
  garbageCollectSharedDependencyImages(options.repoRoot);
  runGit(options.repoRoot, ["worktree", "prune", "--expire", "now"]);
}

if (import.meta.path === Bun.main) {
  await main();
}
