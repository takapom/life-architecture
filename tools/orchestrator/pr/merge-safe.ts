#!/usr/bin/env bun

import {
  classifyBranchRefDeletionDisposition as classifyBranchRefDeletionDispositionCore,
  classifyMergedTaskWorktreeDisposition as classifyMergedTaskWorktreeDispositionCore,
  classifyRemoteBranchDeleteResult as classifyRemoteBranchDeleteResultCore,
  clearMergedTaskCleanupProtectionLease as clearMergedTaskCleanupProtectionLeaseCore,
  findSupplementalMergedTaskWorktrees as findSupplementalMergedTaskWorktreesCore,
  resolveTaskWorktreeProtectionLeasePath as resolveTaskWorktreeProtectionLeasePathCore,
  shouldReanchorCleanupToMainWorktree as shouldReanchorCleanupToMainWorktreeCore,
} from "./merge-safe/cleanup";
import { parseArgs } from "./merge-safe/cli";
import { runSafeMerge } from "./merge-safe/flow";
import { classifyCanonicalPrLifecycleState as classifyCanonicalPrLifecycleStateCore } from "./merge-safe/github";

export const classifyCanonicalPrLifecycleState = classifyCanonicalPrLifecycleStateCore;
export const classifyRemoteBranchDeleteResult = classifyRemoteBranchDeleteResultCore;
export const classifyMergedTaskWorktreeDisposition = classifyMergedTaskWorktreeDispositionCore;
export const classifyBranchRefDeletionDisposition = classifyBranchRefDeletionDispositionCore;
export const findSupplementalMergedTaskWorktrees = findSupplementalMergedTaskWorktreesCore;
export const shouldReanchorCleanupToMainWorktree = shouldReanchorCleanupToMainWorktreeCore;
export const resolveTaskWorktreeProtectionLeasePath = resolveTaskWorktreeProtectionLeasePathCore;
export const clearMergedTaskCleanupProtectionLease = clearMergedTaskCleanupProtectionLeaseCore;

if (import.meta.path === Bun.main) {
  try {
    await runSafeMerge(parseArgs(process.argv.slice(2)), {
      cleanupReanchoredEnv: Bun.env.OMTA_PR_MERGE_SAFE_CLEANUP_REANCHORED,
      entrypointPath: import.meta.path,
      env: Bun.env,
      execPath: process.execPath,
    });
  } catch (error) {
    process.stderr.write(`[pr-merge-safe] ERROR: ${(error as Error).message}\n`);
    process.exit(1);
  }
}
