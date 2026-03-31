#!/usr/bin/env bun

import { runTaskScopeCli } from "./task-scope/cli";

// biome-ignore lint/performance/noBarrelFile: canonical compatibility wrapper for task-scope CLI/types while modular internals stay under tools/core/task-scope/**
export {
  deriveCommitUnitKeys,
  deriveTaskScopeAdmissionClassification,
  deriveTaskScopeClassification,
  detectTaskScopeAdmissionConflict,
} from "./task-scope/derivation";
export {
  acquireTaskScopeLock,
  collectTaskScopeLockConflicts,
  listActiveTaskScopeLocks,
  releaseTaskScopeLock,
} from "./task-scope/locks";
export {
  assertNoTaskWorktreeConflicts,
  assertTaskScopeFiles,
  buildTaskScopeManifestFromTaskIssue,
  collectManifestConflicts,
  ensureCurrentTaskSessionArtifacts,
  ensureMaterializedTaskScopeManifest,
  ensureTaskScopeManifest,
  findTaskScopeEscapes,
  materializeTaskScopeManifestForTaskIssue,
  pathMatchesTaskScope,
  readChangedFilesForRange,
  readImmutableTaskScopeManifest,
  readStagedChangedFiles,
  readTaskScopeManifest,
  renderTaskScopeConflictSummary,
  resolveCurrentTaskIssueSourcePath,
  resolveImmutableTaskIssueSourcePath,
  resolveImmutableTaskScopeManifestPath,
  resolveMaterializedTaskIssueSourcePath,
  resolveTaskScopeManifest,
  resolveTaskScopeManifestPath,
  writeImmutableTaskIssueSource,
  writeImmutableTaskScopeManifest,
  writeMaterializedTaskIssueSource,
  writeTaskScopeManifest,
} from "./task-scope/manifest";
export {
  compareTaskScopeResourceClaims,
  deriveTaskScopeResourceClaims,
} from "./task-scope/resource-claims";
export { resolveSerializedScopeKeys, resolveTaskScopeGateKeys } from "./task-scope/scope-gates";
export type {
  CurrentTaskSessionArtifacts,
  IssueSnapshot,
  TaskScopeAdmissionMode,
  TaskScopeConflict,
  TaskScopeConflictClass,
  TaskScopeLock,
  TaskScopeManifest,
  TaskScopeResourceClaim,
  TaskScopeResourceClaimMode,
  TaskScopeVerificationClass,
  TaskScopeVerificationPlan,
  VerifyCacheEntry,
} from "./task-scope/types";
export {
  FULL_BUILD_SENSITIVE_PATTERNS,
  GH_TASK_SEARCH_LIMIT,
  HOT_ROOT_PATTERNS,
  TASK_SCOPE_ADMISSION_MODES,
  TASK_SCOPE_CONFLICT_CLASSES,
  TASK_SCOPE_RESOURCE_CLAIM_MODES,
  TASK_SCOPE_VERIFICATION_CLASSES,
  TASK_SCOPE_VERSION,
  TITLE_TASK_ID_RE,
  VERIFY_CACHE_VERSION,
} from "./task-scope/types";
export { createTaskScopeVerificationPlan } from "./task-scope/verification";
export {
  buildVerifyFingerprint,
  listVerifyCacheEntries,
  readVerifyCacheEntry,
  writeVerifyCacheEntry,
} from "./task-scope/verify-cache";
export { runTaskScopeCli };

if (import.meta.main) {
  try {
    runTaskScopeCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[task-scope] ERROR: ${(error as Error).message}\n`);
    process.exit(1);
  }
}
