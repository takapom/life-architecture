import type { TaskIssue } from "./issue-graph-types";
import { buildOpenLinkedChildTaskCountMap } from "./issue-graph-validate";
import { normalizeTaskId } from "./task-issue-guard";
import { collectTaskSizingFindings } from "./task-sizing";

export type TaskSizingCertificationFailure = {
  issue_number: number;
  task_id: string;
  title: string;
  errors: string[];
};

export type TaskSizingCertificationReport = {
  open_task_count: number;
  certified_task_count: number;
  failing_task_count: number;
  failing_tasks: TaskSizingCertificationFailure[];
};

export function collectTaskSizingCertificationReport(
  issues: TaskIssue[],
  options: {
    taskIds?: Iterable<string>;
  } = {}
): TaskSizingCertificationReport {
  const scopedTaskIds = new Set(
    [...(options.taskIds || [])]
      .map((taskId) => normalizeTaskId(String(taskId || "")))
      .filter(Boolean)
  );
  const limitToScopedTasks = scopedTaskIds.size > 0;
  const openTasks = issues.filter(
    (issue) =>
      issue.state === "open" &&
      (!limitToScopedTasks || scopedTaskIds.has(normalizeTaskId(issue.metadata.task_id)))
  );
  const failingTasks: TaskSizingCertificationFailure[] = [];
  const linkedChildTaskCountByParent = buildOpenLinkedChildTaskCountMap(issues);

  for (const issue of openTasks) {
    const linkedChildTaskCount = Math.max(
      issue.graph.subIssues.length,
      linkedChildTaskCountByParent.get(issue.number) ?? 0
    );
    const findings = collectTaskSizingFindings({
      issueNumber: issue.number,
      taskId: issue.metadata.task_id,
      admissionMode: issue.metadata.admission_mode,
      globalInvariant: issue.metadata.global_invariant,
      unfreezeCondition: issue.metadata.unfreeze_condition,
      allowedFiles: issue.metadata.allowed_files,
      commitUnits: issue.metadata.commit_units,
      reviewerOutcomes: issue.metadata.reviewer_outcomes,
      canonicalGap: issue.metadata.canonical_gap,
      canonicalGapOwner: issue.metadata.canonical_gap_owner,
      canonicalGapReviewDate: issue.metadata.canonical_gap_review_date,
      canonicalDeferralReason: issue.metadata.canonical_deferral_reason,
      canonicalDeferralCondition: issue.metadata.canonical_deferral_condition,
      linkedChildTaskCount,
      taskSizingException: issue.metadata.task_sizing_exception,
      taskSizingExceptionType: issue.metadata.task_sizing_exception_type,
      taskSizingSplitFailure: issue.metadata.task_sizing_split_failure,
      taskSizingExceptionReviewerAttestation:
        issue.metadata.task_sizing_exception_reviewer_attestation,
      taskSizingUnsafeState: issue.metadata.task_sizing_unsafe_state,
      taskSizingAffectedInvariant: issue.metadata.task_sizing_affected_invariant,
      taskSizingAtomicBoundary: issue.metadata.task_sizing_atomic_boundary,
    });
    const errors = [...findings.errors];

    if (errors.length === 0) continue;

    failingTasks.push({
      issue_number: issue.number,
      task_id: issue.metadata.task_id,
      title: issue.title,
      errors,
    });
  }

  return {
    open_task_count: openTasks.length,
    certified_task_count: openTasks.length - failingTasks.length,
    failing_task_count: failingTasks.length,
    failing_tasks: failingTasks,
  };
}
