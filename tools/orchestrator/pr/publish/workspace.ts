import { rmSync } from "node:fs";
import path from "node:path";
import {
  readTaskWorktreeProtectionLease,
  type TaskWorktreeProtectionLease,
  writeTaskWorktreeProtectionLease,
} from "../../../adapters/worktree";
import { runGit, uniqueStrings } from "./common";
import type { WorkspaceMutationState, WorkspaceResidue } from "./contracts";

const PUBLISH_WORKTREE_PROTECTION_REASON = "pr:publish";
const PUBLISH_WORKTREE_PROTECTION_TTL_MS = 2 * 60 * 60 * 1000;

function listDirtyTrackedFiles(repoRoot: string): string[] {
  return uniqueStrings([
    ...runGit(repoRoot, ["diff", "--name-only"], { allowFailure: true })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
    ...runGit(repoRoot, ["diff", "--cached", "--name-only"], { allowFailure: true })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  ]).sort();
}

function listUntrackedFiles(repoRoot: string): string[] {
  return uniqueStrings(
    runGit(repoRoot, ["ls-files", "--others", "--exclude-standard"], {
      allowFailure: true,
    })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  ).sort();
}

export function readWorkspaceMutationState(repoRoot: string): WorkspaceMutationState {
  return {
    tracked: listDirtyTrackedFiles(repoRoot),
    untracked: listUntrackedFiles(repoRoot),
  };
}

export function protectActivePublishWorktree(options: {
  branch: string;
  repoRoot: string;
  taskId: string;
}): TaskWorktreeProtectionLease | null {
  const repoRoot = path.resolve(options.repoRoot);
  const branch = String(options.branch || "").trim();
  if (!branch.startsWith("task/")) {
    return null;
  }
  try {
    return writeTaskWorktreeProtectionLease({
      branch,
      reason: PUBLISH_WORKTREE_PROTECTION_REASON,
      repoRoot,
      taskId: options.taskId,
      ttlMs: PUBLISH_WORKTREE_PROTECTION_TTL_MS,
      worktreePath: repoRoot,
    });
  } catch {
    return null;
  }
}

export function readActivePublishWorktreeProtection(
  repoRoot: string
): TaskWorktreeProtectionLease | null {
  const canonicalRepoRoot = path.resolve(repoRoot);
  try {
    return readTaskWorktreeProtectionLease(canonicalRepoRoot, canonicalRepoRoot);
  } catch {
    return null;
  }
}

export function classifyIntroducedWorkspaceResidue(
  before: WorkspaceMutationState,
  after: WorkspaceMutationState
): WorkspaceResidue {
  const trackedBefore = new Set(before.tracked);
  const untrackedBefore = new Set(before.untracked);

  return {
    tracked: after.tracked.filter((file) => !trackedBefore.has(file)).sort(),
    untracked: after.untracked.filter((file) => !untrackedBefore.has(file)).sort(),
  };
}

function assertRepoRelativePath(repoRoot: string, candidate: string): string {
  const resolvedRepoRoot = path.resolve(repoRoot);
  const resolvedCandidate = path.resolve(repoRoot, candidate);
  if (
    resolvedCandidate !== resolvedRepoRoot &&
    !resolvedCandidate.startsWith(`${resolvedRepoRoot}${path.sep}`)
  ) {
    throw new Error(`workspace residue path escapes repo root: ${candidate}`);
  }
  return resolvedCandidate;
}

function restoreTrackedFiles(repoRoot: string, files: string[]): void {
  if (files.length === 0) {
    return;
  }
  runGit(repoRoot, ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...files]);
}

function removeUntrackedPaths(repoRoot: string, files: string[]): void {
  for (const file of files) {
    rmSync(assertRepoRelativePath(repoRoot, file), { force: true, recursive: true });
  }
}

export function cleanupIntroducedWorkspaceResidue(
  repoRoot: string,
  before: WorkspaceMutationState,
  residue: WorkspaceResidue
): WorkspaceResidue {
  restoreTrackedFiles(repoRoot, residue.tracked);
  removeUntrackedPaths(repoRoot, residue.untracked);
  return classifyIntroducedWorkspaceResidue(before, readWorkspaceMutationState(repoRoot));
}

export function formatWorkspaceResidue(residue: WorkspaceResidue): string[] {
  return [
    ...residue.tracked.map((file) => `- tracked: ${file}`),
    ...residue.untracked.map((file) => `- untracked: ${file}`),
  ];
}
