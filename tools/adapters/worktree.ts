import path from "node:path";

import { canonicalPath as canonicalPathImpl } from "../../platform/dev/worktree/codex-write-scope";
import { extractTaskIdFromWorktreeEntry as extractTaskIdFromWorktreeEntryImpl } from "../../platform/dev/worktree/sibling-task-worktrees";
import {
  isTaskWorktreeProtectionLeaseActive as isTaskWorktreeProtectionLeaseActiveImpl,
  readTaskWorktreeProtectionLease as readTaskWorktreeProtectionLeaseImpl,
  type TaskWorktreeProtectionLease,
  writeTaskWorktreeProtectionLease as writeTaskWorktreeProtectionLeaseImpl,
} from "../../platform/dev/worktree/task-worktree-protection";
import {
  type GitWorktreeEntry,
  listCanonicalTaskWorktrees as listCanonicalTaskWorktreesImpl,
  listGitWorktrees as listGitWorktreesImpl,
  resolveCanonicalArchiveRootFromRepoRoot as resolveCanonicalArchiveRootFromRepoRootImpl,
  resolveCanonicalMainWorktree as resolveCanonicalMainWorktreeImpl,
  resolveCanonicalTaskRootFromRepoRoot as resolveCanonicalTaskRootFromRepoRootImpl,
  resolveTaskWorktreeProtectionRootFromRepoRoot as resolveTaskWorktreeProtectionRootFromRepoRootImpl,
} from "../../platform/dev/worktree/worktree-topology";

export type { GitWorktreeEntry, TaskWorktreeProtectionLease };

export const canonicalPath = canonicalPathImpl;
export const extractTaskIdFromWorktreeEntry = extractTaskIdFromWorktreeEntryImpl;
export const isTaskWorktreeProtectionLeaseActive = isTaskWorktreeProtectionLeaseActiveImpl;
export const listCanonicalTaskWorktrees = listCanonicalTaskWorktreesImpl;
export const listGitWorktrees = listGitWorktreesImpl;
export const readTaskWorktreeProtectionLease = readTaskWorktreeProtectionLeaseImpl;
export const resolveCanonicalArchiveRootFromRepoRoot = resolveCanonicalArchiveRootFromRepoRootImpl;
export const resolveCanonicalMainWorktree = resolveCanonicalMainWorktreeImpl;
export const resolveCanonicalTaskRootFromRepoRoot = resolveCanonicalTaskRootFromRepoRootImpl;
export const resolveTaskWorktreeProtectionRootFromRepoRoot =
  resolveTaskWorktreeProtectionRootFromRepoRootImpl;
export const writeTaskWorktreeProtectionLease = writeTaskWorktreeProtectionLeaseImpl;

export function resolveTaskStartScriptPath(repoRoot: string): string {
  return path.join(repoRoot, "platform/dev/worktree/task-start.sh");
}

export function resolveDependencyMaterializationScriptPath(repoRoot: string): string {
  return path.join(repoRoot, "platform/dev/worktree/dependency-materialization.sh");
}
