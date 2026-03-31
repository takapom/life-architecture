import { normalizePathPattern } from "./issue-graph-types";
import {
  extractHotRootPaths,
  extractTopLevelWriteSetRoots,
  extractWriteSetOwnershipBuckets,
  IMPLEMENTATION_OWNER_ROOTS,
} from "./task-scope/derivation";
import { resolveTaskScopeGateKeys } from "./task-scope/scope-gates";

export const TASK_SIZING_COMMIT_UNIT_WARNING_THRESHOLD = 3;
export const TASK_SIZING_COMMIT_UNIT_EXCEPTION_THRESHOLD = 5;
export const TASK_SIZING_REVIEWER_OUTCOME_WARNING_THRESHOLD = 2;
export const TASK_SIZING_REVIEWER_OUTCOME_EXCEPTION_THRESHOLD = 3;

const FORBIDDEN_DESIGN_DEFERRAL_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  {
    label: "development effort",
    pattern: /\b(?:development|implementation|engineering)\s+effort\b/i,
  },
  { label: "product velocity", pattern: /\bproduct\s+velocity\b/i },
  { label: "high effort", pattern: /\bhigh\s+effort\b/i },
  { label: "too expensive", pattern: /\btoo\s+expensive\b/i },
  { label: "too many files", pattern: /\btoo\s+many\s+files?\b/i },
  { label: "file-count", pattern: /\bfile[- ]count\b/i },
  {
    label: "backward compatibility",
    pattern:
      /\b(?:for|keep(?:ing)?|preserv(?:e|es|ed|ing)|maintain(?:s|ed|ing)?|retain(?:s|ed|ing)?|support(?:s|ed|ing)?|to preserve|to maintain|to keep|to retain|to support)\b[^.\n]{0,24}\bbackward[- ]compatibility\b/i,
  },
  {
    label: "gradual migration",
    pattern:
      /\b(?:for|keep(?:ing)?|preserv(?:e|es|ed|ing)|maintain(?:s|ed|ing)?|retain(?:s|ed|ing)?|support(?:s|ed|ing)?|to preserve|to maintain|to keep|to retain|to support)\b[^.\n]{0,24}\b(?:incremental|gradual)\s+migration\b/i,
  },
  {
    label: "fallback preservation",
    pattern:
      /\b(?:for|keep(?:ing)?|preserv(?:e|es|ed|ing)|maintain(?:s|ed|ing)?|retain(?:s|ed|ing)?|support(?:s|ed|ing)?|to preserve|to maintain|to keep|to retain|to support)\b[^.\n]{0,24}\bfallback\b/i,
  },
  {
    label: "alias preservation",
    pattern:
      /\b(?:for|keep(?:ing)?|preserv(?:e|es|ed|ing)|maintain(?:s|ed|ing)?|retain(?:s|ed|ing)?|support(?:s|ed|ing)?|to preserve|to maintain|to keep|to retain|to support)\b[^.\n]{0,24}\balias(?:es)?\b/i,
  },
  {
    label: "dual-read/write preservation",
    pattern:
      /\b(?:for|keep(?:ing)?|preserv(?:e|es|ed|ing)|maintain(?:s|ed|ing)?|retain(?:s|ed|ing)?|support(?:s|ed|ing)?|to preserve|to maintain|to keep|to retain|to support)\b[^.\n]{0,24}\bdual[- /]?(?:read|write|readwrite)\b/i,
  },
  {
    label: "coexistence window",
    pattern:
      /\b(?:for|keep(?:ing)?|preserv(?:e|es|ed|ing)|maintain(?:s|ed|ing)?|retain(?:s|ed|ing)?|support(?:s|ed|ing)?|to preserve|to maintain|to keep|to retain|to support)\b[^.\n]{0,24}\bcoexist(?:ence|ing)\b/i,
  },
  {
    label: "bridge period",
    pattern:
      /\b(?:for|keep(?:ing)?|preserv(?:e|es|ed|ing)|maintain(?:s|ed|ing)?|retain(?:s|ed|ing)?|support(?:s|ed|ing)?|to preserve|to maintain|to keep|to retain|to support)\b[^.\n]{0,24}\bbridge period\b/i,
  },
] as const;

export type TaskSizingInput = {
  taskId?: string;
  issueNumber?: number;
  admissionMode?: string;
  globalInvariant?: string;
  unfreezeCondition?: string;
  allowedFiles: string[];
  commitUnits: string[];
  reviewerOutcomes?: string[];
  taskSizingException?: string;
  taskSizingExceptionType?: string;
  taskSizingSplitFailure?: string;
  taskSizingExceptionReviewerAttestation?: string;
  taskSizingUnsafeState?: string;
  taskSizingAffectedInvariant?: string;
  taskSizingAtomicBoundary?: string;
  canonicalGap?: string;
  canonicalGapOwner?: string;
  canonicalGapReviewDate?: string;
  canonicalDeferralReason?: string;
  canonicalDeferralCondition?: string;
  linkedChildTaskCount?: number;
};

export type TaskSizingFindings = {
  errors: string[];
  warnings: string[];
};

type WriteSetOwnershipClassification = {
  implementationBuckets: string[];
  governanceDocPaths: string[];
  governanceDocScopeKeys: string[];
};

export { extractHotRootPaths, extractTopLevelWriteSetRoots, extractWriteSetOwnershipBuckets };

type AtomicContractMigrationAttestationField = {
  key:
    | "taskSizingException"
    | "taskSizingSplitFailure"
    | "taskSizingExceptionReviewerAttestation"
    | "taskSizingUnsafeState"
    | "taskSizingAffectedInvariant"
    | "taskSizingAtomicBoundary";
  label: string;
};

const ATOMIC_CONTRACT_MIGRATION_ATTESTATION_FIELDS: ReadonlyArray<AtomicContractMigrationAttestationField> =
  [
    { key: "taskSizingException", label: "task_sizing_exception" },
    { key: "taskSizingSplitFailure", label: "task_sizing_split_failure" },
    {
      key: "taskSizingExceptionReviewerAttestation",
      label: "task_sizing_exception_reviewer_attestation",
    },
    { key: "taskSizingUnsafeState", label: "task_sizing_unsafe_state" },
    { key: "taskSizingAffectedInvariant", label: "task_sizing_affected_invariant" },
    { key: "taskSizingAtomicBoundary", label: "task_sizing_atomic_boundary" },
  ] as const;

function describeTaskSizingTarget(input: TaskSizingInput): string {
  const issueNumber = Number(input.issueNumber || 0);
  const taskId = String(input.taskId || "").trim();
  if (issueNumber > 0 && taskId) {
    return `issue #${issueNumber} (${taskId})`;
  }
  if (issueNumber > 0) {
    return `issue #${issueNumber}`;
  }
  if (taskId) {
    return `task ${taskId}`;
  }
  return "task";
}

function normalizeReviewerOutcomes(values: string[] | undefined): string[] {
  return [...new Set((values || []).map((entry) => String(entry || "").trim()).filter(Boolean))];
}

export function findForbiddenDesignDeferralLabels(value: string): string[] {
  if (!value) return [];
  return FORBIDDEN_DESIGN_DEFERRAL_PATTERNS.filter(({ pattern }) => pattern.test(value)).map(
    ({ label }) => label
  );
}

const GOVERNANCE_DOC_SCOPE_GATE_KEYS = [
  "docs-index",
  "documentation-system",
  "command-surface",
  "task-governance",
  "repo-governance",
] as const;

function classifyWriteSetOwnership(patterns: string[]): WriteSetOwnershipClassification {
  const ownershipBuckets = extractWriteSetOwnershipBuckets(patterns);
  const implementationBuckets = ownershipBuckets.filter((bucket) => {
    const [root = ""] = bucket.split("/", 1);
    return IMPLEMENTATION_OWNER_ROOTS.has(root);
  });
  const governanceDocPaths: string[] = [];
  const governanceDocScopeKeys: string[] = [];

  for (const pattern of patterns.map((value) => normalizePathPattern(value)).filter(Boolean)) {
    if (!pattern.startsWith("docs/")) {
      continue;
    }
    const scopeKeys = resolveTaskScopeGateKeys({
      allowedFiles: [pattern],
      availableKeys: [...GOVERNANCE_DOC_SCOPE_GATE_KEYS],
    }).filter((scopeKey) =>
      GOVERNANCE_DOC_SCOPE_GATE_KEYS.includes(
        scopeKey as (typeof GOVERNANCE_DOC_SCOPE_GATE_KEYS)[number]
      )
    );
    if (scopeKeys.length === 0) {
      continue;
    }
    governanceDocPaths.push(pattern);
    for (const scopeKey of scopeKeys) {
      if (!governanceDocScopeKeys.includes(scopeKey)) {
        governanceDocScopeKeys.push(scopeKey);
      }
    }
  }

  return {
    implementationBuckets,
    governanceDocPaths,
    governanceDocScopeKeys,
  };
}

function isMeaningfulTaskSizingField(value: string | undefined): boolean {
  const normalized = String(value || "").trim();
  return normalized.length > 0 && normalized.toUpperCase() !== "N/A";
}

function listAtomicContractMigrationAttestationGaps(input: TaskSizingInput): string[] {
  if (String(input.taskSizingExceptionType || "").trim() !== "atomic-contract-migration") {
    return [];
  }

  return ATOMIC_CONTRACT_MIGRATION_ATTESTATION_FIELDS.filter(
    ({ key }) => !isMeaningfulTaskSizingField(input[key])
  ).map(({ label }) => label);
}

function hasAtomicContractMigrationAttestation(input: TaskSizingInput): boolean {
  return (
    String(input.taskSizingExceptionType || "").trim() === "atomic-contract-migration" &&
    listAtomicContractMigrationAttestationGaps(input).length === 0
  );
}

export function collectTaskSizingFindings(input: TaskSizingInput): TaskSizingFindings {
  const errors: string[] = [];
  const warnings: string[] = [];
  const admissionMode = String(input.admissionMode || "standard")
    .trim()
    .toLowerCase();
  const globalInvariant = String(input.globalInvariant || "").trim();
  const unfreezeCondition = String(input.unfreezeCondition || "").trim();
  const commitUnitCount = input.commitUnits.length;
  const writeSet = classifyWriteSetOwnership(input.allowedFiles);
  const hotRootPaths = extractHotRootPaths(input.allowedFiles);
  const hotRootBuckets = extractWriteSetOwnershipBuckets(hotRootPaths);
  const reviewerOutcomes = normalizeReviewerOutcomes(input.reviewerOutcomes);
  const reviewerOutcomeCount = reviewerOutcomes.length;
  const target = describeTaskSizingTarget(input);
  const atomicContractMigrationAttestationGaps = listAtomicContractMigrationAttestationGaps(input);
  const atomicContractMigrationAttested = hasAtomicContractMigrationAttestation(input);
  const globalExclusiveAdmission = admissionMode === "global-exclusive";

  if (
    admissionMode !== "standard" &&
    admissionMode !== "landing-exclusive" &&
    admissionMode !== "global-exclusive"
  ) {
    errors.push(
      `${target}: task sizing error: admission_mode must be one of standard|landing-exclusive|global-exclusive`
    );
  }
  if (globalExclusiveAdmission) {
    if (!globalInvariant) {
      errors.push(
        `${target}: task sizing error: global-exclusive admission requires global_invariant`
      );
    }
    if (!unfreezeCondition) {
      errors.push(
        `${target}: task sizing error: global-exclusive admission requires unfreeze_condition`
      );
    }
  } else if (globalInvariant || unfreezeCondition) {
    errors.push(
      `${target}: task sizing error: global_invariant/unfreeze_condition require admission_mode=global-exclusive`
    );
  }

  if (atomicContractMigrationAttestationGaps.length > 0) {
    errors.push(
      `${target}: task sizing error: atomic-contract-migration requires explicit attestation fields (${atomicContractMigrationAttestationGaps.join(", ")})`
    );
  }

  if (reviewerOutcomeCount >= TASK_SIZING_REVIEWER_OUTCOME_EXCEPTION_THRESHOLD) {
    errors.push(
      `${target}: task sizing error: ${reviewerOutcomeCount} reviewer_outcomes exceed the single-task primary-intent threshold; split into sibling tasks before implementation`
    );
  }

  if (commitUnitCount >= TASK_SIZING_COMMIT_UNIT_EXCEPTION_THRESHOLD) {
    errors.push(
      `${target}: task sizing error: ${commitUnitCount} planned commit_units exceed the single-task threshold; split into sibling tasks before implementation`
    );
  }

  if (
    reviewerOutcomeCount >= TASK_SIZING_REVIEWER_OUTCOME_WARNING_THRESHOLD &&
    reviewerOutcomeCount < TASK_SIZING_REVIEWER_OUTCOME_EXCEPTION_THRESHOLD
  ) {
    warnings.push(
      `${target}: task sizing warning: ${reviewerOutcomeCount} reviewer_outcomes listed; keep one primary outcome and confirm any supporting outcome shares the same landing / verification / rollback story`
    );
  }

  if (
    commitUnitCount >= TASK_SIZING_COMMIT_UNIT_WARNING_THRESHOLD &&
    commitUnitCount < TASK_SIZING_COMMIT_UNIT_EXCEPTION_THRESHOLD
  ) {
    warnings.push(
      `${target}: task sizing warning: ${commitUnitCount} planned commit_units exceed the early split-signal threshold; confirm the task still lands as one primary change before implementation`
    );
  }

  if (writeSet.implementationBuckets.length >= 2) {
    if (!atomicContractMigrationAttested && !globalExclusiveAdmission) {
      errors.push(
        `${target}: task sizing error: allowed_files span multiple implementation ownership buckets (${writeSet.implementationBuckets.join(", ")}); split into sibling tasks before implementation`
      );
    }
  }

  if (writeSet.implementationBuckets.length > 0 && writeSet.governanceDocPaths.length > 0) {
    errors.push(
      `${target}: task sizing error: allowed_files mix governance/docs scope (${writeSet.governanceDocPaths.join(", ")}) with implementation owner scope (${writeSet.implementationBuckets.join(", ")}); split the governance/docs work into dedicated child tasks (${writeSet.governanceDocScopeKeys.join(", ")}) before implementation`
    );
  }

  const hotRootMixesControlPlaneAndProductScope =
    hotRootPaths.length > 0 &&
    writeSet.implementationBuckets.length > 0 &&
    hotRootBuckets.some((bucket) => !writeSet.implementationBuckets.includes(bucket)) &&
    writeSet.governanceDocPaths.length === 0;

  if (hotRootMixesControlPlaneAndProductScope) {
    if (!atomicContractMigrationAttested && !globalExclusiveAdmission) {
      errors.push(
        `${target}: task sizing error: allowed_files mix integration-hot paths (${hotRootPaths.join(", ")}) with implementation owner scope (${writeSet.implementationBuckets.join(", ")}); split hot-root governance/tooling work from product-owner changes before implementation`
      );
    }
  }

  return { errors, warnings };
}

export function collectTaskSizingWarnings(input: TaskSizingInput): string[] {
  return collectTaskSizingFindings(input).warnings;
}
