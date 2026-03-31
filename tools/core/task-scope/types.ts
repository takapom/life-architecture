import type { TaskMetadata } from "../issue-graph-types";

export type TaskScopeConflictClass = "parallel-safe" | "serial" | "integration-hot";
export type TaskScopeVerificationClass = "cheap" | "affected-typecheck" | "full-build-sensitive";
export type TaskScopeAdmissionMode = "standard" | "landing-exclusive" | "global-exclusive";
export type TaskScopeResourceClaimMode = "exclusive" | "shared-read" | "shared-write-forbidden";
export type TaskScopeStopReason =
  | "blocked_real_scope_conflict"
  | "blocked_real_resource_conflict"
  | "blocked_real_global_exclusive_conflict"
  | "blocked_authority_unavailable_after_repair";

export const TASK_SCOPE_CONFLICT_CLASSES = ["parallel-safe", "serial", "integration-hot"] as const;
export const TASK_SCOPE_VERIFICATION_CLASSES = [
  "cheap",
  "affected-typecheck",
  "full-build-sensitive",
] as const;
export const TASK_SCOPE_ADMISSION_MODES = [
  "standard",
  "landing-exclusive",
  "global-exclusive",
] as const;
export const TASK_SCOPE_RESOURCE_CLAIM_MODES = [
  "exclusive",
  "shared-read",
  "shared-write-forbidden",
] as const;
export const TASK_SCOPE_STOP_REASONS = [
  "blocked_real_scope_conflict",
  "blocked_real_resource_conflict",
  "blocked_real_global_exclusive_conflict",
  "blocked_authority_unavailable_after_repair",
] as const;

export type TaskScopeResourceClaim = {
  mode: TaskScopeResourceClaimMode;
  resource: string;
};

export type TaskScopeManifest = {
  version: 1;
  taskId: string;
  issueNumber: number;
  issueUrl: string;
  title: string;
  ownerBucket: string;
  ownerBuckets: string[];
  allowedGlobs: string[];
  commitUnits: string[];
  admissionMode?: TaskScopeAdmissionMode;
  globalInvariant?: string;
  unfreezeCondition?: string;
  scopeGateKeys: string[];
  serializedScopeKeys: string[];
  hotRootPaths: string[];
  touchesHotRoot: boolean;
  conflictClass: TaskScopeConflictClass;
  verificationClass: TaskScopeVerificationClass;
  resourceClaims?: TaskScopeResourceClaim[];
  dependencyEdges: string[];
  acceptanceChecks: string[];
  tests: string[];
  createdAt: string;
  updatedAt: string;
};

export type TaskScopeLock = {
  version: 1;
  lockId: string;
  taskId: string;
  issueNumber: number;
  issueUrl: string;
  sessionId: string;
  branch: string;
  pid: number;
  worktreePath: string;
  ownerBucket: string;
  ownerBuckets: string[];
  allowedGlobs: string[];
  commitUnits: string[];
  admissionMode?: TaskScopeAdmissionMode;
  globalInvariant?: string;
  unfreezeCondition?: string;
  scopeGateKeys: string[];
  serializedScopeKeys: string[];
  hotRootPaths: string[];
  conflictClass: TaskScopeConflictClass;
  verificationClass: TaskScopeVerificationClass;
  resourceClaims?: TaskScopeResourceClaim[];
  createdAt: string;
  updatedAt: string;
};

export type TaskScopeConflict = {
  candidatePath: string;
  candidateTaskId: string;
  otherPath: string;
  otherTaskId: string;
  reason:
    | "serialized_scope_overlap"
    | "commit_unit_overlap"
    | "hot_root_lock"
    | "resource_claim_overlap"
    | "global_exclusive_lock";
  resource?: string;
  serializedScopeKey?: string;
  commitUnit?: string;
  candidateClaimMode?: TaskScopeResourceClaimMode;
  otherClaimMode?: TaskScopeResourceClaimMode;
};

export type VerifyCacheEntry = {
  version: 1;
  fingerprint: string;
  taskId: string;
  verificationClass: TaskScopeVerificationClass;
  mergeBase: string | null;
  manifestDigest: string;
  commandPlanDigest: string;
  changedFiles: string[];
  commands: string[];
  lockfileHash: string;
  createdAt: string;
};

export type VerifyCacheStatusReason =
  | "hit"
  | "no-task-scope"
  | "no-commands"
  | "cache-empty"
  | "manifest-drift"
  | "command-plan-drift"
  | "changed-files-drift"
  | "merge-base-drift"
  | "lockfile-drift";

export type TaskScopeVerificationPlan = {
  taskScope: TaskScopeManifest | null;
  verificationClass: TaskScopeVerificationClass | null;
  verifyCacheFingerprint: string | null;
  verifyCacheEntry: VerifyCacheEntry | null;
  verifyCacheHit: boolean;
  verifyCacheReason: VerifyCacheStatusReason | null;
  verifyCacheDetail: string | null;
};

export type IssueSnapshot = {
  body: string;
  issueNumber: number;
  issueUrl: string;
  labels: string[];
  metadata: TaskMetadata;
  title: string;
};

export const TASK_SCOPE_VERSION = 1;
export const VERIFY_CACHE_VERSION = 1;
export const GH_TASK_SEARCH_LIMIT = 200;
export const HOT_ROOT_PATTERNS = [
  "package.json",
  "bun.lock",
  "tsconfig.base.json",
  "turbo.json",
  "docs/contracts/governance/**",
  "platform/dev/hooks/**",
  "platform/delivery/ci/**",
  "packages/*/package.json",
  "packages/*/src/index.ts",
  "packages/*/src/index.tsx",
  "packages/*/index.ts",
  "packages/*/index.tsx",
] as const;
export const FULL_BUILD_SENSITIVE_PATTERNS = [
  ...HOT_ROOT_PATTERNS,
  "platform/dev/local/**",
  "platform/dev/worktree/**",
  "platform/delivery/testing/**",
  "tools/orchestrator/pr/**",
  "tools/apps/task/**",
  "scripts/check-local-pre-push-contract.ts",
  "scripts/ensure-bun-install.sh",
  "tools/core/task-scope.ts",
] as const;
export const TITLE_TASK_ID_RE = /\[TASK\]\s+([A-Z][A-Z0-9-]*-\d{3,}[a-z]?)\s*:/u;
