import type { TaskIssue } from "./issue-graph-types";
import { buildOpenLinkedChildTaskCountMap } from "./issue-graph-validate";
import {
  normalizeIssueBodyForComparison,
  renderIssueBody,
  tryBuildTaskSpecFromIssueSnapshot,
} from "./task-issue-contract";
import { collectTaskSizingFindings } from "./task-sizing";

export type TaskSizingBackfillStatus =
  | "certified"
  | "normalization_only"
  | "split_required"
  | "manual_review";

export type TaskSizingBackfillAnalysis = {
  issue_number: number;
  task_id: string;
  title: string;
  status: TaskSizingBackfillStatus;
  can_apply: boolean;
  task_sizing_errors: string[];
  spec_build_errors: string[];
  normalization_mismatches: string[];
  next_action: string;
  normalized_title: string;
  normalized_body: string;
};

export type TaskSizingBackfillReport = {
  open_task_count: number;
  certified_count: number;
  normalization_only_count: number;
  split_required_count: number;
  manual_review_count: number;
  failing_count: number;
  issues: TaskSizingBackfillAnalysis[];
};

type AnalysisInput = {
  issue: TaskIssue;
  title: string;
  body: string;
  linkedChildTaskCount?: number;
};

function normalizeErrors(values: string[]): string[] {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function classifyFindingStatus(errors: string[]): TaskSizingBackfillStatus {
  if (errors.some((error) => error.includes("split into sibling tasks before implementation"))) {
    return "split_required";
  }

  return "manual_review";
}

function describeNextAction(status: TaskSizingBackfillStatus): string {
  switch (status) {
    case "certified":
      return "No migration action required";
    case "normalization_only":
      return "Normalize the canonical issue title/body with backfill apply";
    case "split_required":
      return "Split the scope into sibling task issues before execution continues";
    case "manual_review":
      return "Manual issue review is required before task sizing can certify";
  }
}

export function analyzeTaskSizingBackfill(input: AnalysisInput): TaskSizingBackfillAnalysis {
  const rebuilt = tryBuildTaskSpecFromIssueSnapshot({
    title: input.title,
    body: input.body,
    metadata: input.issue.metadata,
  });
  const derivedTaskId = input.issue.metadata.task_id || rebuilt.spec?.task_id || "";
  const taskSizingFindings = collectTaskSizingFindings({
    issueNumber: input.issue.number,
    taskId: derivedTaskId,
    admissionMode: input.issue.metadata.admission_mode,
    globalInvariant: input.issue.metadata.global_invariant,
    unfreezeCondition: input.issue.metadata.unfreeze_condition,
    allowedFiles: input.issue.metadata.allowed_files,
    commitUnits: input.issue.metadata.commit_units,
    reviewerOutcomes: input.issue.metadata.reviewer_outcomes,
    canonicalGap: input.issue.metadata.canonical_gap,
    canonicalGapOwner: input.issue.metadata.canonical_gap_owner,
    canonicalGapReviewDate: input.issue.metadata.canonical_gap_review_date,
    canonicalDeferralReason: input.issue.metadata.canonical_deferral_reason,
    canonicalDeferralCondition: input.issue.metadata.canonical_deferral_condition,
    linkedChildTaskCount: input.linkedChildTaskCount ?? input.issue.graph.subIssues.length,
    taskSizingException: input.issue.metadata.task_sizing_exception,
    taskSizingExceptionType: input.issue.metadata.task_sizing_exception_type,
    taskSizingSplitFailure: input.issue.metadata.task_sizing_split_failure,
    taskSizingExceptionReviewerAttestation:
      input.issue.metadata.task_sizing_exception_reviewer_attestation,
    taskSizingUnsafeState: input.issue.metadata.task_sizing_unsafe_state,
    taskSizingAffectedInvariant: input.issue.metadata.task_sizing_affected_invariant,
    taskSizingAtomicBoundary: input.issue.metadata.task_sizing_atomic_boundary,
  });
  const taskSizingErrors = normalizeErrors(taskSizingFindings.errors);

  if (taskSizingErrors.length > 0) {
    const status = classifyFindingStatus(taskSizingErrors);
    return {
      issue_number: input.issue.number,
      task_id: derivedTaskId,
      title: input.title,
      status,
      can_apply: false,
      task_sizing_errors: taskSizingErrors,
      spec_build_errors: [],
      normalization_mismatches: [],
      next_action: describeNextAction(status),
      normalized_title: "",
      normalized_body: "",
    };
  }

  const specBuildErrors = normalizeErrors(rebuilt.errors);
  if (!rebuilt.spec || specBuildErrors.length > 0) {
    return {
      issue_number: input.issue.number,
      task_id: derivedTaskId,
      title: input.title,
      status: "manual_review",
      can_apply: false,
      task_sizing_errors: [],
      spec_build_errors: specBuildErrors,
      normalization_mismatches: [],
      next_action: describeNextAction("manual_review"),
      normalized_title: "",
      normalized_body: "",
    };
  }

  const normalizedTitle = rebuilt.spec.title.trim();
  const normalizedBody = normalizeIssueBodyForComparison(renderIssueBody(rebuilt.spec));
  const currentTitle = String(input.title || "").trim();
  const currentBody = normalizeIssueBodyForComparison(input.body);
  const normalizationMismatches: string[] = [];

  if (normalizedTitle !== currentTitle) {
    normalizationMismatches.push(
      `title drift (expected='${normalizedTitle || "(empty)"}', actual='${currentTitle || "(empty)"}')`
    );
  }
  if (normalizedBody !== currentBody) {
    normalizationMismatches.push("body drift");
  }

  const status: TaskSizingBackfillStatus =
    normalizationMismatches.length === 0 ? "certified" : "normalization_only";

  return {
    issue_number: input.issue.number,
    task_id: derivedTaskId,
    title: input.title,
    status,
    can_apply: status === "normalization_only",
    task_sizing_errors: [],
    spec_build_errors: [],
    normalization_mismatches: normalizationMismatches,
    next_action: describeNextAction(status),
    normalized_title: normalizedTitle,
    normalized_body: normalizedBody,
  };
}

export function collectTaskSizingBackfillReport(
  analyses: TaskSizingBackfillAnalysis[]
): TaskSizingBackfillReport {
  const certifiedCount = analyses.filter((entry) => entry.status === "certified").length;
  const normalizationOnlyCount = analyses.filter(
    (entry) => entry.status === "normalization_only"
  ).length;
  const splitRequiredCount = analyses.filter((entry) => entry.status === "split_required").length;
  const manualReviewCount = analyses.filter((entry) => entry.status === "manual_review").length;

  return {
    open_task_count: analyses.length,
    certified_count: certifiedCount,
    normalization_only_count: normalizationOnlyCount,
    split_required_count: splitRequiredCount,
    manual_review_count: manualReviewCount,
    failing_count: analyses.length - certifiedCount,
    issues: analyses,
  };
}

export function buildTaskSizingBackfillLinkedChildTaskCountMap(
  issues: TaskIssue[]
): Map<number, number> {
  return buildOpenLinkedChildTaskCountMap(issues);
}
