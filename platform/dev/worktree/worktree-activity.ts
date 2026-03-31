import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

export const ACTIVE_WORKTREE_ACTIVITY_WINDOW_MS = 10 * 60 * 1000;

export const WORKTREE_ACTIVITY_IGNORED_PATH_SEGMENTS = [
  ".artifacts",
  ".git",
  ".next",
  ".tmp",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
] as const;

const IGNORED_ACTIVITY_PATH_SEGMENTS = new Set(WORKTREE_ACTIVITY_IGNORED_PATH_SEGMENTS);

export type WorktreeActivityState = "active writer" | "stale/no-writer";

export type WorktreeActivitySnapshot = {
  activityWindowMs: number;
  hasGitWorktreeContext: boolean;
  hasRecentRelevantFileActivity: boolean;
  hasRelevantGitWorktreeChanges: boolean;
  isActiveWriter: boolean;
  lastRelevantFileUpdateAt: string | null;
  lastRelevantFileUpdateAtMs: number | null;
  relevantGitWorktreeChangeCount: number;
  relevantGitWorktreeChangedPaths: string[];
  scannedFileCount: number;
};

export type WorktreeActivityInspection = WorktreeActivitySnapshot & {
  activityWindowStartedAt: string;
  decisionReason: string;
  ignoredPathSegments: readonly string[];
  inspectedAt: string;
  inspectedWorktreePath: string;
  state: WorktreeActivityState;
};

function normalizeRelativePath(value: string): string {
  return value
    .split(path.sep)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join(path.sep);
}

export function isIgnoredWorktreeActivityPath(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) {
    return false;
  }
  return normalized.split(path.sep).some((segment) => IGNORED_ACTIVITY_PATH_SEGMENTS.has(segment));
}

function collectNewestRelevantFileUpdateMs(worktreePath: string): {
  lastRelevantFileUpdateAtMs: number | null;
  scannedFileCount: number;
} {
  const rootPath = path.resolve(worktreePath);
  const pending = [rootPath];
  let lastRelevantFileUpdateAtMs: number | null = null;
  let scannedFileCount = 0;

  while (pending.length > 0) {
    const currentPath = pending.pop();
    if (!currentPath) {
      continue;
    }

    for (const entry of readdirSync(currentPath, { withFileTypes: true })) {
      if (IGNORED_ACTIVITY_PATH_SEGMENTS.has(entry.name)) {
        continue;
      }

      const entryPath = path.join(currentPath, entry.name);
      const relativePath = path.relative(rootPath, entryPath);
      if (isIgnoredWorktreeActivityPath(relativePath)) {
        continue;
      }

      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const stats = statSync(entryPath);
      scannedFileCount += 1;
      if (
        Number.isFinite(stats.mtimeMs) &&
        (lastRelevantFileUpdateAtMs === null || stats.mtimeMs > lastRelevantFileUpdateAtMs)
      ) {
        lastRelevantFileUpdateAtMs = stats.mtimeMs;
      }
    }
  }

  return {
    lastRelevantFileUpdateAtMs,
    scannedFileCount,
  };
}

function runGitStatus(worktreePath: string): { hasGitWorktreeContext: boolean; output: string } {
  const result = spawnSync(
    "git",
    ["-C", path.resolve(worktreePath), "status", "--porcelain=v1", "--untracked-files=all"],
    {
      stderr: "pipe",
      stdout: "pipe",
    }
  );
  if (result.status === 0) {
    return {
      hasGitWorktreeContext: true,
      output: new TextDecoder().decode(result.stdout),
    };
  }
  return {
    hasGitWorktreeContext: false,
    output: "",
  };
}

function normalizeGitStatusPath(value: string): string {
  return normalizeRelativePath(
    String(value || "")
      .replace(/^"/, "")
      .replace(/"$/, "")
      .trim()
  );
}

function collectRelevantGitWorktreeChangedPaths(worktreePath: string): {
  hasGitWorktreeContext: boolean;
  relevantGitWorktreeChangedPaths: string[];
} {
  const status = runGitStatus(worktreePath);
  if (!status.hasGitWorktreeContext) {
    return {
      hasGitWorktreeContext: false,
      relevantGitWorktreeChangedPaths: [],
    };
  }

  const relevantPaths = new Set<string>();
  for (const rawLine of status.output.split(/\r?\n/u)) {
    const line = String(rawLine || "");
    if (!line.trim()) {
      continue;
    }
    const payload = line.slice(3).trim();
    const candidatePath = payload.includes(" -> ")
      ? payload.split(" -> ").at(-1) || payload
      : payload;
    const normalizedPath = normalizeGitStatusPath(candidatePath);
    if (!normalizedPath || isIgnoredWorktreeActivityPath(normalizedPath)) {
      continue;
    }
    relevantPaths.add(normalizedPath);
  }

  return {
    hasGitWorktreeContext: true,
    relevantGitWorktreeChangedPaths: [...relevantPaths].sort((left, right) =>
      left.localeCompare(right)
    ),
  };
}

export function inspectWorktreeRelevantFileActivity(
  worktreePath: string,
  options: {
    activityWindowMs?: number;
    nowMs?: number;
  } = {}
): WorktreeActivitySnapshot {
  const activityWindowMs = Math.max(
    1,
    Number(options.activityWindowMs ?? ACTIVE_WORKTREE_ACTIVITY_WINDOW_MS)
  );
  const nowMs = options.nowMs ?? Date.now();
  const { lastRelevantFileUpdateAtMs, scannedFileCount } =
    collectNewestRelevantFileUpdateMs(worktreePath);
  const { hasGitWorktreeContext, relevantGitWorktreeChangedPaths } =
    collectRelevantGitWorktreeChangedPaths(worktreePath);
  const hasRecentRelevantFileActivity =
    lastRelevantFileUpdateAtMs !== null && nowMs - lastRelevantFileUpdateAtMs <= activityWindowMs;
  const hasRelevantGitWorktreeChanges = relevantGitWorktreeChangedPaths.length > 0;

  return {
    activityWindowMs,
    hasGitWorktreeContext,
    hasRecentRelevantFileActivity,
    hasRelevantGitWorktreeChanges,
    isActiveWriter: hasGitWorktreeContext
      ? hasRelevantGitWorktreeChanges
      : hasRecentRelevantFileActivity,
    lastRelevantFileUpdateAt:
      lastRelevantFileUpdateAtMs === null
        ? null
        : new Date(lastRelevantFileUpdateAtMs).toISOString(),
    lastRelevantFileUpdateAtMs,
    relevantGitWorktreeChangeCount: relevantGitWorktreeChangedPaths.length,
    relevantGitWorktreeChangedPaths,
    scannedFileCount,
  };
}

export function hasRecentRelevantWorktreeActivity(
  worktreePath: string,
  options: {
    activityWindowMs?: number;
    nowMs?: number;
  } = {}
): boolean {
  return inspectWorktreeRelevantFileActivity(worktreePath, options).isActiveWriter;
}

export function classifyWorktreeActivityState(
  snapshot: Pick<WorktreeActivitySnapshot, "isActiveWriter">
): WorktreeActivityState {
  return snapshot.isActiveWriter ? "active writer" : "stale/no-writer";
}

function describeWorktreeDecisionReason(
  snapshot: WorktreeActivitySnapshot,
  activityWindowMinutes: number
): string {
  if (snapshot.hasRelevantGitWorktreeChanges) {
    const scope =
      snapshot.relevantGitWorktreeChangeCount === 1
        ? "1 relevant unresolved git worktree change"
        : `${snapshot.relevantGitWorktreeChangeCount} relevant unresolved git worktree changes`;
    return `${scope} still marks this worktree as an active writer`;
  }

  if (!snapshot.hasGitWorktreeContext && snapshot.hasRecentRelevantFileActivity) {
    const updatedAt = snapshot.lastRelevantFileUpdateAt
      ? `; last relevant update at ${snapshot.lastRelevantFileUpdateAt}`
      : "";
    return `recent relevant file activity is inside the last ${activityWindowMinutes} minutes and no git worktree context is available${updatedAt}`;
  }

  if (snapshot.hasRecentRelevantFileActivity) {
    const updatedAt = snapshot.lastRelevantFileUpdateAt
      ? `; last relevant update at ${snapshot.lastRelevantFileUpdateAt}`
      : "";
    return `recent relevant file activity exists, but no unresolved relevant git worktree changes were detected${updatedAt}`;
  }

  if (!snapshot.hasGitWorktreeContext) {
    return "no git worktree context is available and no recent relevant file activity was detected";
  }

  return `no unresolved relevant git worktree changes or recent relevant file activity were detected in the last ${activityWindowMinutes} minutes`;
}

export function inspectCanonicalWorktreeActivity(
  worktreePath: string,
  options: {
    activityWindowMs?: number;
    nowMs?: number;
  } = {}
): WorktreeActivityInspection {
  const canonicalWorktreePath = path.resolve(worktreePath);
  const activityWindowMs = Math.max(
    1,
    Number(options.activityWindowMs ?? ACTIVE_WORKTREE_ACTIVITY_WINDOW_MS)
  );
  const nowMs = options.nowMs ?? Date.now();
  const snapshot = inspectWorktreeRelevantFileActivity(canonicalWorktreePath, {
    activityWindowMs,
    nowMs,
  });
  const state = classifyWorktreeActivityState(snapshot);
  const activityWindowStartedAt = new Date(nowMs - activityWindowMs).toISOString();

  return {
    ...snapshot,
    activityWindowStartedAt,
    decisionReason: describeWorktreeDecisionReason(
      snapshot,
      Math.max(1, Math.round(activityWindowMs / 60_000))
    ),
    ignoredPathSegments: [...WORKTREE_ACTIVITY_IGNORED_PATH_SEGMENTS],
    inspectedAt: new Date(nowMs).toISOString(),
    inspectedWorktreePath: canonicalWorktreePath,
    state,
  };
}
