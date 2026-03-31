import { spawnSync } from "node:child_process";
import path from "node:path";

import { TASK_ID_PATTERN } from "../../../tools/core/issue-graph-types";
import { extractTaskIdFromBranch, normalizeTaskId } from "../../../tools/core/task-issue-guard";
import {
  isTaskWorktreeProtectionLeaseActive,
  readTaskWorktreeProtectionLease,
  type TaskWorktreeProtectionLease,
} from "./task-worktree-protection";

export type RegisteredSiblingTaskWorktreeState = {
  branch: string;
  dirty: boolean;
  entry: string;
  hasActiveProtectionLease: boolean;
  isCurrent: boolean;
  path: string;
  probeFailures?: RegisteredSiblingTaskWorktreeProbeFailure[];
  protectionLease: TaskWorktreeProtectionLease | null;
  taskId: string | null;
  uniqueCommitsAgainstOriginMain: number;
};

export type RegisteredSiblingTaskWorktreeProbeName = "git-rev-list" | "git-status";

export type RegisteredSiblingTaskWorktreeProbeFailure = {
  detail: string;
  exitCode?: number;
  probe: RegisteredSiblingTaskWorktreeProbeName;
  timedOut: boolean;
  timeoutMs: number;
};

type GitProbeResult =
  | {
      ok: true;
      stdout: string;
    }
  | {
      ok: false;
      detail: string;
      exitCode?: number;
      timedOut: boolean;
      timeoutMs: number;
    };

type SiblingTaskWorktreeProbeOptions = {
  concurrency?: number;
  probeRunner?: (
    worktreePath: string,
    args: string[],
    timeoutMs: number
  ) => Promise<GitProbeResult>;
  statusTimeoutMs?: number;
  revListTimeoutMs?: number;
};

export type SiblingTaskWorktreeCandidate = {
  branch: string;
  entry: string;
  hasActiveProtectionLease: boolean;
  isCurrent: boolean;
  path: string;
  protectionLease: TaskWorktreeProtectionLease | null;
  taskId: string | null;
};

function normalizeBranch(ref: string): string {
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

export function extractTaskIdFromWorktreeEntry(entry: string): string | null {
  const parts = path
    .basename(String(entry || "").trim())
    .split("-")
    .map((part) => part.trim())
    .filter(Boolean);
  let matchedTaskId: string | null = null;

  for (let index = 2; index <= parts.length; index += 1) {
    const candidate = normalizeTaskId(parts.slice(0, index).join("-"));
    if (!TASK_ID_PATTERN.test(candidate)) {
      continue;
    }
    matchedTaskId = candidate;
  }

  return matchedTaskId;
}

function runGit(repoRoot: string, args: string[]): string {
  const result = spawnSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    return "";
  }
  return String(result.stdout || "").trim();
}

function listWorktrees(repoRoot: string): Array<{ branch: string; path: string }> {
  const output = runGit(repoRoot, ["worktree", "list", "--porcelain"]);
  const worktrees: Array<{ branch: string; path: string }> = [];
  let currentPath = "";
  let currentBranch = "";

  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) {
      if (currentPath) {
        worktrees.push({ branch: normalizeBranch(currentBranch), path: currentPath });
      }
      currentPath = "";
      currentBranch = "";
      continue;
    }
    if (line.startsWith("worktree ")) {
      currentPath = path.resolve(line.slice("worktree ".length).trim());
      continue;
    }
    if (line.startsWith("branch ")) {
      currentBranch = line.slice("branch ".length).trim();
    }
  }

  if (currentPath) {
    worktrees.push({ branch: normalizeBranch(currentBranch), path: currentPath });
  }

  return worktrees;
}

function isDirtyWorktree(worktreePath: string): boolean {
  return runGit(worktreePath, ["status", "--short"]).length > 0;
}

function countUniqueCommitsAgainstOriginMain(worktreePath: string): number {
  const output = runGit(worktreePath, ["rev-list", "--count", "origin/main..HEAD"]);
  const parsed = Number.parseInt(output, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function resolveProbeOptions(
  options: SiblingTaskWorktreeProbeOptions = {}
): Required<SiblingTaskWorktreeProbeOptions> {
  return {
    concurrency: Math.max(1, Number(options.concurrency || 8)),
    probeRunner: options.probeRunner || runGitProbe,
    revListTimeoutMs: Math.max(1, Number(options.revListTimeoutMs || 2_000)),
    statusTimeoutMs: Math.max(1, Number(options.statusTimeoutMs || 5_000)),
  };
}

async function mapWithConcurrency<T, U>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<U>
): Promise<U[]> {
  const results = new Array<U>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await mapper(items[index] as T);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

async function runGitProbe(
  worktreePath: string,
  args: string[],
  timeoutMs: number
): Promise<GitProbeResult> {
  const command = ["git", "-C", worktreePath, ...args];
  const subprocess = Bun.spawn(command, {
    stderr: "pipe",
    stdout: "pipe",
  });

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    subprocess.kill();
  }, timeoutMs);

  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      subprocess.exited,
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text(),
    ]);

    if (timedOut) {
      return {
        ok: false,
        detail: `git ${args.join(" ")} timed out after ${timeoutMs}ms`,
        timedOut: true,
        timeoutMs,
      };
    }

    if (exitCode !== 0) {
      const detail = `${stderr}\n${stdout}`.trim();
      return {
        ok: false,
        detail: detail || `git ${args.join(" ")} exited with code ${exitCode}`,
        exitCode,
        timedOut: false,
        timeoutMs,
      };
    }

    return {
      ok: true,
      stdout: stdout.trim(),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function listSiblingTaskWorktreeCandidates(params: {
  currentRepoRoot: string;
  siblingWtRoot: string;
}): SiblingTaskWorktreeCandidate[] {
  const currentRepoRoot = path.resolve(params.currentRepoRoot);
  const siblingWtRoot = path.resolve(params.siblingWtRoot);

  return listWorktrees(currentRepoRoot)
    .filter((worktree) => path.dirname(worktree.path) === siblingWtRoot)
    .map((worktree) => {
      const protectionLease = readTaskWorktreeProtectionLease(currentRepoRoot, worktree.path);
      const entry = path.basename(worktree.path);
      return {
        branch: worktree.branch,
        entry,
        hasActiveProtectionLease: isTaskWorktreeProtectionLeaseActive(protectionLease),
        isCurrent: worktree.path === currentRepoRoot,
        path: worktree.path,
        protectionLease,
        taskId: extractTaskIdFromBranch(worktree.branch) || extractTaskIdFromWorktreeEntry(entry),
      };
    })
    .filter((worktree) => worktree.taskId !== null)
    .sort((left, right) => left.entry.localeCompare(right.entry));
}

export async function probeSiblingTaskWorktreeStates(
  candidates: readonly SiblingTaskWorktreeCandidate[],
  options: SiblingTaskWorktreeProbeOptions = {}
): Promise<RegisteredSiblingTaskWorktreeState[]> {
  const resolvedOptions = resolveProbeOptions(options);

  return await mapWithConcurrency(candidates, resolvedOptions.concurrency, async (candidate) => {
    const [statusResult, revListResult] = await Promise.all([
      resolvedOptions.probeRunner(
        candidate.path,
        ["status", "--short"],
        resolvedOptions.statusTimeoutMs
      ),
      resolvedOptions.probeRunner(
        candidate.path,
        ["rev-list", "--count", "origin/main..HEAD"],
        resolvedOptions.revListTimeoutMs
      ),
    ]);

    const probeFailures: RegisteredSiblingTaskWorktreeProbeFailure[] = [];
    if (!statusResult.ok) {
      probeFailures.push({
        detail: statusResult.detail,
        exitCode: statusResult.exitCode,
        probe: "git-status",
        timedOut: statusResult.timedOut,
        timeoutMs: statusResult.timeoutMs,
      });
    }
    if (!revListResult.ok) {
      probeFailures.push({
        detail: revListResult.detail,
        exitCode: revListResult.exitCode,
        probe: "git-rev-list",
        timedOut: revListResult.timedOut,
        timeoutMs: revListResult.timeoutMs,
      });
    }

    const parsedUniqueCommits =
      revListResult.ok && Number.isFinite(Number.parseInt(revListResult.stdout, 10))
        ? Number.parseInt(revListResult.stdout, 10)
        : 1;

    return {
      branch: candidate.branch,
      dirty: statusResult.ok ? statusResult.stdout.length > 0 : true,
      entry: candidate.entry,
      hasActiveProtectionLease: candidate.hasActiveProtectionLease,
      isCurrent: candidate.isCurrent,
      path: candidate.path,
      probeFailures,
      protectionLease: candidate.protectionLease,
      taskId: candidate.taskId,
      uniqueCommitsAgainstOriginMain: parsedUniqueCommits,
    };
  });
}

export async function listRegisteredSiblingTaskWorktreeStatesBounded(
  params: {
    currentRepoRoot: string;
    siblingWtRoot: string;
  },
  options: SiblingTaskWorktreeProbeOptions = {}
): Promise<RegisteredSiblingTaskWorktreeState[]> {
  return await probeSiblingTaskWorktreeStates(listSiblingTaskWorktreeCandidates(params), options);
}

export function listRegisteredSiblingTaskWorktreeStates(params: {
  currentRepoRoot: string;
  siblingWtRoot: string;
}): RegisteredSiblingTaskWorktreeState[] {
  const currentRepoRoot = path.resolve(params.currentRepoRoot);

  return listSiblingTaskWorktreeCandidates(params).map((candidate) => ({
    branch: candidate.branch,
    dirty: isDirtyWorktree(candidate.path),
    entry: candidate.entry,
    hasActiveProtectionLease: candidate.hasActiveProtectionLease,
    isCurrent: candidate.path === currentRepoRoot,
    path: candidate.path,
    probeFailures: [],
    protectionLease: candidate.protectionLease,
    taskId: candidate.taskId,
    uniqueCommitsAgainstOriginMain: countUniqueCommitsAgainstOriginMain(candidate.path),
  }));
}

export function findStaleSiblingTaskWorktrees(
  states: Iterable<RegisteredSiblingTaskWorktreeState>
): RegisteredSiblingTaskWorktreeState[] {
  return [...states]
    .filter((state) => !state.isCurrent)
    .filter((state) => state.taskId !== null)
    .filter((state) => !state.hasActiveProtectionLease)
    .filter((state) => !state.dirty)
    .filter((state) => state.uniqueCommitsAgainstOriginMain === 0)
    .sort((left, right) => left.entry.localeCompare(right.entry));
}
