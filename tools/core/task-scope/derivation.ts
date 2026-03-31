import { getExecutionPlanTaskScopeContract } from "../../contracts/execution-plan";
import { normalizePathPattern } from "../issue-graph-types";
import { overlapsPathPattern } from "../path-patterns";
import { compareTaskScopeResourceClaims, deriveTaskScopeResourceClaims } from "./resource-claims";
import { resolveSerializedScopeKeys, resolveTaskScopeGateKeys } from "./scope-gates";
import {
  FULL_BUILD_SENSITIVE_PATTERNS,
  HOT_ROOT_PATTERNS,
  type TaskScopeAdmissionMode,
  type TaskScopeConflict,
  type TaskScopeConflictClass,
  type TaskScopeResourceClaim,
  type TaskScopeVerificationClass,
} from "./types";

export const IMPLEMENTATION_OWNER_ROOTS = new Set([
  "apps",
  "apps-oss",
  "packages",
  "domains",
  "processes",
]);

export type TaskScopeDerivation = {
  allowedGlobs: string[];
  commitUnitKeys: string[];
  topLevelRoots: string[];
  ownerBucket: string;
  ownerBuckets: string[];
  scopeGateKeys: string[];
  serializedScopeKeys: string[];
  hotRootPaths: string[];
  touchesHotRoot: boolean;
  conflictClass: TaskScopeConflictClass;
  verificationClass: TaskScopeVerificationClass;
  resourceClaims: TaskScopeResourceClaim[];
};

type TaskScopeAdmissionInput = {
  admissionMode?: TaskScopeAdmissionMode;
  allowedGlobs: string[];
  commitUnits: string[];
  globalInvariant?: string;
  taskId: string;
  unfreezeCondition?: string;
};

export function normalizeTaskScopeAllowedGlobs(allowedFiles: string[]): string[] {
  return [
    ...new Set(
      (allowedFiles || []).map((pattern) => normalizePathPattern(pattern)).filter(Boolean)
    ),
  ];
}

export function deriveCommitUnitKeys(commitUnits: string[]): string[] {
  return [
    ...new Set(
      (commitUnits || [])
        .map((value) => String(value || "").trim())
        .filter(Boolean)
        .map((value) =>
          value
            .replace(/^CU\d+\s*:\s*/i, "")
            .trim()
            .toLowerCase()
            .replace(/\s+/g, " ")
        )
        .filter(Boolean)
    ),
  ].sort((left, right) => left.localeCompare(right));
}

export function extractTopLevelWriteSetRoots(patterns: string[]): string[] {
  const roots = new Set<string>();

  for (const pattern of patterns) {
    const normalized = normalizePathPattern(pattern);
    if (!normalized) continue;

    const trimmed = normalized.replace(/^\/+/, "");
    const [rawRoot = ""] = trimmed.split("/", 1);
    const root = rawRoot.trim() || "(root)";
    roots.add(root);
  }

  return [...roots].sort((left, right) => left.localeCompare(right));
}

export function extractWriteSetOwnershipBuckets(patterns: string[]): string[] {
  const buckets = new Set<string>();

  for (const pattern of patterns) {
    const normalized = normalizePathPattern(pattern);
    if (!normalized) continue;

    const parts = normalized.replace(/^\/+/, "").split("/").filter(Boolean);
    const [root = "", owner = ""] = parts;
    if (!root) continue;

    if (IMPLEMENTATION_OWNER_ROOTS.has(root) && owner) {
      buckets.add(`${root}/${owner}`);
      continue;
    }

    buckets.add(root);
  }

  return [...buckets].sort((left, right) => left.localeCompare(right));
}

export function extractHotRootPaths(patterns: string[]): string[] {
  const normalizedPatterns = normalizeTaskScopeAllowedGlobs(patterns);
  return normalizedPatterns
    .filter((pattern) =>
      HOT_ROOT_PATTERNS.some((hotRootPattern) => overlapsPathPattern(pattern, hotRootPattern))
    )
    .sort((left, right) => left.localeCompare(right));
}

export function resolveTaskScopeConflictClass(
  touchesHotRoot: boolean,
  ownerBucketCount: number
): TaskScopeConflictClass {
  if (touchesHotRoot) {
    return "integration-hot";
  }
  if (ownerBucketCount <= 1) {
    return "parallel-safe";
  }
  return "serial";
}

export function resolveTaskScopeVerificationClass(
  allowedGlobs: string[],
  topLevelRoots: string[],
  touchesHotRoot: boolean
): TaskScopeVerificationClass {
  if (
    touchesHotRoot ||
    allowedGlobs.some((pattern) =>
      FULL_BUILD_SENSITIVE_PATTERNS.some((sensitivePattern) =>
        overlapsPathPattern(pattern, sensitivePattern)
      )
    )
  ) {
    return "full-build-sensitive";
  }
  if (topLevelRoots.some((root) => IMPLEMENTATION_OWNER_ROOTS.has(root))) {
    return "affected-typecheck";
  }
  return "cheap";
}

export function deriveTaskScopeClassification(allowedFiles: string[]): TaskScopeDerivation {
  const allowedGlobs = normalizeTaskScopeAllowedGlobs(allowedFiles);
  const topLevelRoots = extractTopLevelWriteSetRoots(allowedGlobs);
  const ownerBuckets = extractWriteSetOwnershipBuckets(allowedGlobs);
  const scopeGateKeys = resolveTaskScopeGateKeys({
    allowedFiles: allowedGlobs,
    availableKeys: Object.keys(
      getExecutionPlanTaskScopeContract().serialized_scope_key_by_scope_gate_key
    ),
  });
  const serializedScopeKeys = resolveSerializedScopeKeys(
    scopeGateKeys,
    getExecutionPlanTaskScopeContract().serialized_scope_key_by_scope_gate_key
  );
  const hotRootPaths = extractHotRootPaths(allowedGlobs);
  const touchesHotRoot = hotRootPaths.length > 0;
  const resourceClaims = deriveTaskScopeResourceClaims(allowedGlobs);

  return {
    allowedGlobs,
    commitUnitKeys: [],
    topLevelRoots,
    ownerBucket: ownerBuckets[0] || "(root)",
    ownerBuckets,
    scopeGateKeys,
    serializedScopeKeys,
    hotRootPaths,
    touchesHotRoot,
    conflictClass: resolveTaskScopeConflictClass(touchesHotRoot, ownerBuckets.length),
    verificationClass: resolveTaskScopeVerificationClass(
      allowedGlobs,
      topLevelRoots,
      touchesHotRoot
    ),
    resourceClaims,
  };
}

export function deriveTaskScopeAdmissionClassification(options: {
  allowedFiles: string[];
  commitUnits: string[];
}): TaskScopeDerivation {
  return {
    ...deriveTaskScopeClassification(options.allowedFiles),
    commitUnitKeys: deriveCommitUnitKeys(options.commitUnits),
  };
}

function normalizeAdmissionMode(
  value: TaskScopeAdmissionMode | string | undefined
): TaskScopeAdmissionMode {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "global-exclusive") return "global-exclusive";
  if (normalized === "landing-exclusive") return "landing-exclusive";
  return "standard";
}

export function detectTaskScopeAdmissionConflict(
  candidate: TaskScopeAdmissionInput,
  other: TaskScopeAdmissionInput
): Omit<TaskScopeConflict, "candidateTaskId" | "otherTaskId"> | null {
  const candidateAdmissionMode = normalizeAdmissionMode(candidate.admissionMode);
  const otherAdmissionMode = normalizeAdmissionMode(other.admissionMode);
  if (candidateAdmissionMode === "global-exclusive") {
    if (otherAdmissionMode === "global-exclusive") {
      return {
        candidatePath: candidate.globalInvariant || candidate.allowedGlobs[0] || candidate.taskId,
        otherPath: other.globalInvariant || other.allowedGlobs[0] || other.taskId,
        reason: "global_exclusive_lock",
      };
    }
    return null;
  }
  if (otherAdmissionMode === "global-exclusive") {
    return {
      candidatePath: candidate.allowedGlobs[0] || candidate.taskId,
      otherPath: other.globalInvariant || other.allowedGlobs[0] || other.taskId,
      reason: "global_exclusive_lock",
    };
  }

  const candidateDerived = deriveTaskScopeAdmissionClassification({
    allowedFiles: candidate.allowedGlobs,
    commitUnits: candidate.commitUnits,
  });
  const otherDerived = deriveTaskScopeAdmissionClassification({
    allowedFiles: other.allowedGlobs,
    commitUnits: other.commitUnits,
  });

  for (const serializedScopeKey of candidateDerived.serializedScopeKeys) {
    if (!otherDerived.serializedScopeKeys.includes(serializedScopeKey)) continue;
    return {
      candidatePath: serializedScopeKey,
      otherPath: serializedScopeKey,
      reason: "serialized_scope_overlap",
      serializedScopeKey,
    };
  }

  const resourceConflict = compareTaskScopeResourceClaims(
    candidateDerived.resourceClaims,
    otherDerived.resourceClaims
  );
  if (resourceConflict) {
    return {
      candidatePath: resourceConflict.resource,
      otherPath: resourceConflict.resource,
      reason: "resource_claim_overlap",
      resource: resourceConflict.resource,
      candidateClaimMode: resourceConflict.candidateClaimMode,
      otherClaimMode: resourceConflict.otherClaimMode,
    };
  }

  if (candidateDerived.touchesHotRoot && otherDerived.touchesHotRoot) {
    for (const candidatePath of candidateDerived.hotRootPaths) {
      for (const otherPath of otherDerived.hotRootPaths) {
        if (!overlapsPathPattern(candidatePath, otherPath)) continue;
        return {
          candidatePath,
          otherPath,
          reason: "hot_root_lock",
        };
      }
    }
  }

  for (const commitUnit of candidateDerived.commitUnitKeys) {
    if (!otherDerived.commitUnitKeys.includes(commitUnit)) continue;
    return {
      candidatePath: commitUnit,
      otherPath: commitUnit,
      reason: "commit_unit_overlap",
      commitUnit,
    };
  }

  return null;
}
