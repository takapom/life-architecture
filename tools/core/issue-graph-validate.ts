import {
  type AdmissionConflict,
  normalizePathPattern,
  TASK_ID_PATTERN,
  type TaskIssue,
  VALID_STATUSES,
  VALID_TYPES,
  type ValidationResult,
} from "./issue-graph-types";
import { buildTaskScopeManifestFromTaskIssue, collectManifestConflicts } from "./task-scope";
import { collectTaskSizingFindings } from "./task-sizing";

const COMMIT_UNIT_DECLARATION_RE = /^CU\d+:/i;

export type DuplicateTaskScopeConflict = {
  left_issue_number: number;
  left_task_id: string;
  right_issue_number: number;
  right_task_id: string;
  scope_signature: string;
};

function detectReadyAdmissionConflicts(ready: TaskIssue[]): AdmissionConflict[] {
  const conflicts: AdmissionConflict[] = [];

  for (let i = 0; i < ready.length; i += 1) {
    const left = ready[i];
    const leftManifest = buildTaskScopeManifestFromTaskIssue(left);
    for (let j = i + 1; j < ready.length; j += 1) {
      const right = ready[j];
      const [conflict] = collectManifestConflicts(leftManifest, [
        buildTaskScopeManifestFromTaskIssue(right),
      ]);
      if (!conflict) continue;
      conflicts.push({
        left_task_id: left.metadata.task_id,
        left_issue_number: left.number,
        left_pattern: conflict.candidatePath,
        right_task_id: right.metadata.task_id,
        right_issue_number: right.number,
        right_pattern: conflict.otherPath,
        scope: (() => {
          if (conflict.reason === "serialized_scope_overlap") {
            return "serialized_scope";
          }
          if (conflict.reason === "resource_claim_overlap") {
            return "resource_claim";
          }
          if (conflict.reason === "hot_root_lock") {
            return "hot_root";
          }
          if (conflict.reason === "commit_unit_overlap") {
            return "commit_unit";
          }
          return "global_exclusive";
        })(),
      });
    }
  }

  return conflicts;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeComparableText(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function normalizeTaskSummaryFromTitle(issue: TaskIssue): string {
  const title = String(issue.title || "").trim();
  const taskId = String(issue.metadata.task_id || "").trim();
  if (!title) return "";
  if (!taskId) return normalizeComparableText(title);

  const taskTitlePrefix = new RegExp(`^\\[TASK\\]\\s+${escapeRegex(taskId)}\\s*:\\s*`, "i");
  const retiredTitlePrefix = new RegExp(`^${escapeRegex(taskId)}\\s*:\\s*`, "i");
  return normalizeComparableText(
    title.replace(taskTitlePrefix, "").replace(retiredTitlePrefix, "")
  );
}

function buildTaskScopeSignature(issue: TaskIssue): string {
  return JSON.stringify({
    summary: normalizeTaskSummaryFromTitle(issue),
    task_type: normalizeComparableText(issue.metadata.task_type),
    allowed_files: [...issue.metadata.allowed_files].map(normalizePathPattern).sort(),
    reviewer_outcomes: [...issue.metadata.reviewer_outcomes].map(normalizeComparableText).sort(),
    acceptance_criteria: [...issue.metadata.acceptance_criteria]
      .map(normalizeComparableText)
      .sort(),
  });
}

export function buildOpenLinkedChildTaskCountMap(issues: TaskIssue[]): Map<number, number> {
  const counts = new Map<number, number>();

  for (const issue of issues) {
    if (issue.state !== "open") continue;
    const parentNumber = Number(issue.graph.parent || 0);
    if (!Number.isInteger(parentNumber) || parentNumber <= 0) continue;
    counts.set(parentNumber, (counts.get(parentNumber) ?? 0) + 1);
  }

  return counts;
}

export function collectCanonicalTaskPresentationErrors(issue: TaskIssue): string[] {
  if (issue.state !== "open") return [];

  const errors: string[] = [];
  const taskId = String(issue.metadata.task_id || "").trim();
  const title = String(issue.title || "").trim();

  if (taskId) {
    const expectedPrefix = `[TASK] ${taskId}:`;
    if (!title.startsWith(expectedPrefix)) {
      errors.push(
        `issue #${issue.number} (${taskId}): title must start with canonical prefix '${expectedPrefix}'`
      );
    }
  }

  for (const commitUnit of issue.metadata.commit_units) {
    if (COMMIT_UNIT_DECLARATION_RE.test(String(commitUnit || "").trim())) continue;
    errors.push(
      `issue #${issue.number} (${taskId || "<missing-task-id>"}): commit_units must use canonical 'CU<n>:' declarations`
    );
    break;
  }

  return errors;
}

export function detectDuplicateTaskScopeConflicts(
  issues: TaskIssue[]
): DuplicateTaskScopeConflict[] {
  const conflicts: DuplicateTaskScopeConflict[] = [];
  const firstBySignature = new Map<string, TaskIssue>();

  for (const issue of issues) {
    if (issue.state !== "open") continue;
    const signature = buildTaskScopeSignature(issue);
    const prior = firstBySignature.get(signature);
    if (!prior) {
      firstBySignature.set(signature, issue);
      continue;
    }

    conflicts.push({
      left_issue_number: prior.number,
      left_task_id: prior.metadata.task_id,
      right_issue_number: issue.number,
      right_task_id: issue.metadata.task_id,
      scope_signature: signature,
    });
  }

  return conflicts;
}

function validateMetadata(
  issue: TaskIssue,
  errors: string[],
  warnings: string[],
  linkedChildTaskCount: number
): void {
  const meta = issue.metadata;
  const isOpenIssue = issue.state === "open";
  const requiresExecutionPlan = issue.state === "open" && meta.status !== "backlog";

  if (isOpenIssue && !meta.task_id) {
    errors.push(`issue #${issue.number}: task_id is required`);
  }

  if (isOpenIssue && meta.task_id && !TASK_ID_PATTERN.test(meta.task_id)) {
    errors.push(`issue #${issue.number}: invalid task_id ${meta.task_id}`);
  }

  if (requiresExecutionPlan && !VALID_TYPES.has(meta.task_type)) {
    errors.push(`issue #${issue.number}: invalid task_type ${meta.task_type}`);
  }

  if (!VALID_STATUSES.has(meta.status)) {
    errors.push(`issue #${issue.number}: invalid status ${meta.status}`);
  }

  if (issue.state === "open" && meta.status === "done") {
    errors.push(`issue #${issue.number}: open issue cannot have status=done`);
  }

  if (requiresExecutionPlan && meta.allowed_files.length === 0) {
    errors.push(`issue #${issue.number} (${meta.task_id}): allowed_files is required`);
  }

  if (requiresExecutionPlan && meta.acceptance_checks.length === 0) {
    errors.push(`issue #${issue.number} (${meta.task_id}): acceptance_checks is required`);
  }

  if (requiresExecutionPlan && meta.tests.length === 0) {
    errors.push(`issue #${issue.number} (${meta.task_id}): tests is required`);
  }

  if (requiresExecutionPlan && meta.commit_units.length === 0) {
    errors.push(`issue #${issue.number} (${meta.task_id}): commit_units is required`);
  }

  if (requiresExecutionPlan && meta.task_type === "bugfix") {
    if (meta.acceptance_criteria.length === 0) {
      errors.push(
        `issue #${issue.number} (${meta.task_id}): acceptance_criteria is required for bugfix`
      );
    }
    if (!meta.rca_scope) {
      errors.push(`issue #${issue.number} (${meta.task_id}): rca_scope is required for bugfix`);
    }
  }

  const selfDep = meta.deps.find((dep) => dep === meta.task_id);
  if (selfDep) {
    errors.push(`issue #${issue.number} (${meta.task_id}): deps must not contain itself`);
  }

  if (isOpenIssue) {
    errors.push(...collectCanonicalTaskPresentationErrors(issue));

    const findings = collectTaskSizingFindings({
      issueNumber: issue.number,
      taskId: meta.task_id,
      admissionMode: meta.admission_mode,
      globalInvariant: meta.global_invariant,
      unfreezeCondition: meta.unfreeze_condition,
      allowedFiles: meta.allowed_files,
      commitUnits: meta.commit_units,
      reviewerOutcomes: meta.reviewer_outcomes,
      canonicalGap: meta.canonical_gap,
      canonicalGapOwner: meta.canonical_gap_owner,
      canonicalGapReviewDate: meta.canonical_gap_review_date,
      canonicalDeferralReason: meta.canonical_deferral_reason,
      canonicalDeferralCondition: meta.canonical_deferral_condition,
      linkedChildTaskCount,
      taskSizingException: meta.task_sizing_exception,
      taskSizingExceptionType: meta.task_sizing_exception_type,
      taskSizingSplitFailure: meta.task_sizing_split_failure,
      taskSizingExceptionReviewerAttestation: meta.task_sizing_exception_reviewer_attestation,
      taskSizingUnsafeState: meta.task_sizing_unsafe_state,
      taskSizingAffectedInvariant: meta.task_sizing_affected_invariant,
      taskSizingAtomicBoundary: meta.task_sizing_atomic_boundary,
    });
    errors.push(...findings.errors);
    warnings.push(...findings.warnings);
  }
}

function detectCycles(byTaskId: Map<string, TaskIssue>, errors: string[]): void {
  const visitState = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];

  const dfs = (taskId: string): boolean => {
    visitState.set(taskId, 1);
    stack.push(taskId);

    const issue = byTaskId.get(taskId);
    if (!issue) return false;

    for (const dep of issue.metadata.deps) {
      if (!byTaskId.has(dep)) continue;

      const depState = visitState.get(dep) ?? 0;
      if (depState === 0) {
        if (dfs(dep)) return true;
        continue;
      }

      if (depState === 1) {
        const cycleStart = stack.indexOf(dep);
        const cyclePath = [...stack.slice(cycleStart), dep].join(" -> ");
        errors.push(`cyclic dependency detected: ${cyclePath}`);
        return true;
      }
    }

    stack.pop();
    visitState.set(taskId, 2);
    return false;
  };

  for (const taskId of byTaskId.keys()) {
    if ((visitState.get(taskId) ?? 0) !== 0) continue;
    if (dfs(taskId)) break;
  }
}

export function validateIssueGraph(issues: TaskIssue[]): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const admissionConflicts: AdmissionConflict[] = [];
  const linkedChildTaskCountByParent = buildOpenLinkedChildTaskCountMap(issues);
  const byIssueNumber = new Map<number, TaskIssue>(
    issues
      .filter((issue) => Number.isInteger(issue.number) && issue.number > 0)
      .map((issue) => [issue.number, issue])
  );

  if (issues.length === 0) {
    errors.push("no task issues found (label=task)");
    return { errors, warnings, ready: [], open: [], done: [], admission_conflicts: [] };
  }

  const byTaskId = new Map<string, TaskIssue>();

  for (const issue of issues) {
    validateMetadata(
      issue,
      errors,
      warnings,
      Math.max(issue.graph.subIssues.length, linkedChildTaskCountByParent.get(issue.number) ?? 0)
    );

    const taskId = issue.metadata.task_id;
    if (!taskId) {
      continue;
    }
    const duplicate = byTaskId.get(taskId);
    if (!duplicate) {
      byTaskId.set(taskId, issue);
      continue;
    }

    if (duplicate.state === "open" && issue.state === "open") {
      errors.push(
        `duplicate task_id ${taskId}: issue #${duplicate.number} and issue #${issue.number}`
      );
      continue;
    }

    if (duplicate.state === "open") {
      warnings.push(
        `duplicate task_id ${taskId}: keeping open issue #${duplicate.number}, ignoring closed #${issue.number}`
      );
      continue;
    }

    if (issue.state === "open") {
      warnings.push(
        `duplicate task_id ${taskId}: replacing closed issue #${duplicate.number} with open #${issue.number}`
      );
      byTaskId.set(taskId, issue);
      continue;
    }

    // Both closed: keep the newer issue number as canonical.
    if (issue.number > duplicate.number) {
      warnings.push(
        `duplicate task_id ${taskId}: keeping newer closed issue #${issue.number}, dropping #${duplicate.number}`
      );
      byTaskId.set(taskId, issue);
      continue;
    }
    warnings.push(
      `duplicate task_id ${taskId}: keeping newer closed issue #${duplicate.number}, dropping #${issue.number}`
    );
  }

  for (const issue of issues) {
    if (issue.state !== "open") continue;
    const unresolvedBlockedBy = issue.graph.blockedBy.filter((blockedByIssueNumber) => {
      const blockedByIssue = byIssueNumber.get(blockedByIssueNumber);
      return !blockedByIssue || !blockedByIssue.metadata.task_id;
    });
    if (unresolvedBlockedBy.length > 0) {
      errors.push(
        `issue #${issue.number} (${issue.metadata.task_id}): blockedBy links must resolve to canonical task issues (${unresolvedBlockedBy.map((entry) => `#${entry}`).join(", ")})`
      );
    }
    for (const dep of issue.metadata.deps) {
      if (!byTaskId.has(dep)) {
        errors.push(`issue #${issue.number} (${issue.metadata.task_id}): unknown dep ${dep}`);
      }
    }
  }

  detectCycles(byTaskId, errors);

  const open = issues.filter((issue) => issue.state === "open");
  const done = issues.filter((issue) => issue.metadata.status === "done");

  for (const issue of open) {
    if (issue.metadata.status !== "ready") continue;
    const unresolved = issue.metadata.deps.filter((dep) => {
      const dependency = byTaskId.get(dep);
      return dependency?.metadata.status !== "done";
    });
    if (unresolved.length > 0) {
      errors.push(
        `issue #${issue.number} (${issue.metadata.task_id}): status=ready requires done dependencies (${unresolved.join(", ")})`
      );
    }
  }

  const ready = open.filter((issue) => issue.metadata.status === "ready");
  for (const conflict of detectReadyAdmissionConflicts(ready)) {
    admissionConflicts.push(conflict);
    errors.push(
      `ready task admission conflict detected: ${conflict.left_task_id} (#${conflict.left_issue_number}) and ${conflict.right_task_id} (#${conflict.right_issue_number}) share admission scope (${conflict.left_pattern} <-> ${conflict.right_pattern}); resolve admission_conflict before concurrent scheduling`
    );
  }

  for (const conflict of detectDuplicateTaskScopeConflicts(open)) {
    errors.push(
      `duplicate open task scope detected: ${conflict.left_task_id} (#${conflict.left_issue_number}) and ${conflict.right_task_id} (#${conflict.right_issue_number}) describe the same canonical scope; close, replace, or normalize one issue instead of keeping both open`
    );
  }

  return { errors, warnings, ready, open, done, admission_conflicts: admissionConflicts };
}

export function sortIssuesForExecutionPlan(issues: TaskIssue[]): TaskIssue[] {
  return [...issues].sort((a, b) => {
    const byPriority = a.metadata.priority - b.metadata.priority;
    if (byPriority !== 0) return byPriority;
    return a.metadata.task_id.localeCompare(b.metadata.task_id);
  });
}
