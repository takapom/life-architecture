import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";

import { fail } from "../../../tools/adapters/cli";
import { extractTaskIdFromBranch } from "../../../tools/core/task-issue-guard";

export type GitWorktree = {
  path: string;
  branch: string;
};

export type TrackedDiffSnapshot = {
  stagedPatch: string;
  stagedPaths: string[];
  unstagedPatch: string;
  unstagedPaths: string[];
};

export function canonicalPath(targetPath: string): string {
  try {
    return realpathSync.native(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

export function runGit(repoRoot: string, args: string[]): string {
  const result = spawnSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const detail = `${result.stderr || ""}\n${result.stdout || ""}`.trim();
    fail(`git ${args.join(" ")} failed: ${detail || `exit=${result.status}`}`);
  }
  return String(result.stdout || "");
}

export function parseGitWorktreeList(raw: string): GitWorktree[] {
  const worktrees: GitWorktree[] = [];
  let currentPath = "";
  let currentBranch = "";

  const flush = () => {
    if (!currentPath) return;
    worktrees.push({
      path: canonicalPath(currentPath),
      branch: currentBranch,
    });
    currentPath = "";
    currentBranch = "";
  };

  for (const line of String(raw || "").split(/\r?\n/u)) {
    if (!line.trim()) {
      flush();
      continue;
    }
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length).trim();
      continue;
    }
    if (line.startsWith("branch ")) {
      currentBranch = line.slice("branch ".length).trim();
    }
  }
  flush();

  return worktrees;
}

export function listGitWorktrees(repoRoot: string): GitWorktree[] {
  return parseGitWorktreeList(runGit(repoRoot, ["worktree", "list", "--porcelain"]));
}

export function shortBranch(branch: string): string {
  return String(branch || "")
    .replace(/^refs\/heads\//u, "")
    .trim();
}

export function isInsidePath(candidatePath: string, parentPath: string): boolean {
  if (candidatePath === parentPath) return true;
  return candidatePath.startsWith(`${parentPath}${path.sep}`);
}

export function findContainingWorktree(
  worktrees: GitWorktree[],
  candidatePath: string
): GitWorktree | null {
  const resolvedCandidate = canonicalPath(candidatePath);
  const matches = worktrees
    .filter((worktree) => isInsidePath(resolvedCandidate, worktree.path))
    .sort((left, right) => right.path.length - left.path.length);
  return matches[0] || null;
}

export function resolveMainWorktree(worktrees: GitWorktree[]): GitWorktree {
  const mainWorktree = worktrees.find((worktree) => shortBranch(worktree.branch) === "main");
  if (!mainWorktree) {
    fail("failed to resolve the canonical main worktree from git worktree list");
  }
  return mainWorktree;
}

export function resolveAllowedWorktreeRoot(worktrees: GitWorktree[]): string {
  return canonicalPath(path.dirname(resolveMainWorktree(worktrees).path));
}

export function ensureCanonicalTaskWorktree(
  target: GitWorktree,
  allowedWorktreeRoot: string,
  taskWorktreeGuidance: string
): GitWorktree {
  const branch = shortBranch(target.branch);
  if (branch === "main") {
    fail(
      `refusing to launch Codex from the base repo worktree (${target.path}). ${taskWorktreeGuidance}`
    );
  }
  if (!branch.startsWith("task/")) {
    fail(
      `refusing to launch Codex from non-task worktree '${branch || "(detached)"}'. ${taskWorktreeGuidance}`
    );
  }
  if (!extractTaskIdFromBranch(branch)) {
    fail(`task worktree branch does not encode a valid task id: ${branch}`);
  }
  if (!isInsidePath(target.path, allowedWorktreeRoot)) {
    fail(
      `canonical task worktrees must live under ${allowedWorktreeRoot}; received ${target.path}`
    );
  }
  return target;
}

export function resolveTargetWorktree(options: {
  startPath: string;
  taskId: string;
  taskWorktreeGuidance: string;
  worktrees: GitWorktree[];
}): GitWorktree {
  const { worktrees, taskId, taskWorktreeGuidance } = options;
  const allowedWorktreeRoot = resolveAllowedWorktreeRoot(worktrees);

  if (taskId) {
    const matches = worktrees.filter((worktree) => {
      const branch = shortBranch(worktree.branch);
      return extractTaskIdFromBranch(branch) === taskId;
    });
    if (matches.length === 0) {
      fail(
        `no checked-out task worktree found for ${taskId}. Create it with bun run wt:start -- --task-id ${taskId} --slug <short-title>.`
      );
    }
    if (matches.length > 1) {
      fail(
        `multiple checked-out task worktrees found for ${taskId}: ${matches.map((worktree) => worktree.path).join(", ")}`
      );
    }
    return ensureCanonicalTaskWorktree(matches[0], allowedWorktreeRoot, taskWorktreeGuidance);
  }

  const containingWorktree = findContainingWorktree(worktrees, options.startPath);
  if (!containingWorktree) {
    fail(`current path is not inside a tracked OMTA worktree. ${taskWorktreeGuidance}`);
  }
  return ensureCanonicalTaskWorktree(containingWorktree, allowedWorktreeRoot, taskWorktreeGuidance);
}

function parseLineList(raw: string): string[] {
  return raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function captureTrackedDiffSnapshot(repoRoot: string): TrackedDiffSnapshot {
  return {
    stagedPatch: runGit(repoRoot, ["diff", "--cached", "--binary", "--no-ext-diff", "--relative"]),
    stagedPaths: parseLineList(runGit(repoRoot, ["diff", "--cached", "--name-only", "--relative"])),
    unstagedPatch: runGit(repoRoot, ["diff", "--binary", "--no-ext-diff", "--relative"]),
    unstagedPaths: parseLineList(runGit(repoRoot, ["diff", "--name-only", "--relative"])),
  };
}

export function trackedDiffSnapshotChanged(
  before: TrackedDiffSnapshot,
  after: TrackedDiffSnapshot
): boolean {
  return before.stagedPatch !== after.stagedPatch || before.unstagedPatch !== after.unstagedPatch;
}

export function formatTrackedDiffChange(options: {
  after: TrackedDiffSnapshot;
  before: TrackedDiffSnapshot;
  label: string;
}): string | null {
  const { before, after, label } = options;
  if (!trackedDiffSnapshotChanged(before, after)) {
    return null;
  }

  const paths = Array.from(
    new Set([
      ...before.stagedPaths,
      ...before.unstagedPaths,
      ...after.stagedPaths,
      ...after.unstagedPaths,
    ])
  ).sort((left, right) => left.localeCompare(right));

  const lines = [`[start-codex] ${label} tracked diff changed during the Codex session.`];
  if (paths.length > 0) {
    lines.push("[start-codex] tracked paths:");
    for (const currentPath of paths) {
      lines.push(`  - ${currentPath}`);
    }
  } else {
    lines.push(
      "[start-codex] tracked diff content changed, but no path list could be derived from the current diff."
    );
  }
  lines.push(
    "[start-codex] If those paths were already dirty before launch, their tracked diff changed further during the session."
  );
  return lines.join("\n");
}
