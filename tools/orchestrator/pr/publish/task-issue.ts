import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { fail } from "../../../adapters/cli";
import {
  normalizeTaskId,
  type TaskSpec,
  tryBuildTaskSpecFromIssueSnapshot,
} from "../../../core/task-governance";
import type { GraphIssueNode } from "../../../core/task-governance-types";
import {
  extractLabels,
  normalizeSourceIssue,
  parseIssueState,
  parseTaskMetadata,
} from "../../../core/task-governance-types";
import type { ExpectedTaskIssue } from "../check-pr-body-traceability";
import type { TaskIssueSnapshot } from "./contracts";

export function buildExpectedTaskIssue(
  repository: string,
  issue: Pick<TaskIssueSnapshot, "issueUrl" | "number">,
  spec: TaskSpec,
  taskId: string
): ExpectedTaskIssue {
  return {
    taskId,
    issueNumber: issue.number,
    issueUrl: issue.issueUrl || `https://github.com/${repository}/issues/${issue.number}`,
    admissionMode: spec.admission_mode,
    globalInvariant: spec.global_invariant,
    unfreezeCondition: spec.unfreeze_condition,
    allowedFiles: spec.allowed_files,
    commitUnits: spec.commit_units,
    reviewerOutcomes: spec.reviewer_outcomes,
    canonicalGap: spec.canonical_gap,
    canonicalGapOwner: spec.canonical_gap_owner,
    canonicalGapReviewDate: spec.canonical_gap_review_date,
    canonicalDeferralReason: spec.canonical_deferral_reason,
    canonicalDeferralCondition: spec.canonical_deferral_condition,
    taskSizingException: spec.task_sizing_exception,
    taskSizingExceptionType: spec.task_sizing_exception_type,
    taskSizingSplitFailure: spec.task_sizing_split_failure,
    taskSizingExceptionReviewerAttestation: spec.task_sizing_exception_reviewer_attestation,
    taskSizingUnsafeState: spec.task_sizing_unsafe_state,
    taskSizingAffectedInvariant: spec.task_sizing_affected_invariant,
    taskSizingAtomicBoundary: spec.task_sizing_atomic_boundary,
  };
}

export function loadTaskIssueSnapshotFromSource(
  sourcePath: string,
  taskId: string
): TaskIssueSnapshot {
  const absolutePath = path.resolve(sourcePath);
  if (!existsSync(absolutePath)) {
    fail(`issue source file not found: ${absolutePath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolutePath, "utf8")) as unknown;
  } catch (error) {
    fail(`failed to parse issue source ${absolutePath}: ${(error as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    fail(`issue source must be a JSON array: ${absolutePath}`);
  }

  const normalizedTaskId = normalizeTaskId(taskId);
  const matches = parsed
    .filter(
      (entry): entry is GraphIssueNode =>
        Boolean(entry) && typeof entry === "object" && !Array.isArray(entry)
    )
    .map((entry) => normalizeSourceIssue(entry))
    .map((entry) => {
      const labels = extractLabels(entry.labels);
      return {
        body: String(entry.body || ""),
        issueUrl: String(entry.html_url || entry.url || "").trim(),
        labels,
        metadata: parseTaskMetadata({
          issueNumber: entry.number,
          labels,
          source: entry,
          state: parseIssueState(entry.state),
          title: entry.title,
        }),
        number: Number(entry.number || 0),
        title: String(entry.title || "").trim(),
      };
    })
    .filter((entry) => entry.number > 0)
    .filter((entry) => entry.labels.some((label) => label.trim().toLowerCase() === "task"))
    .filter((entry) => normalizeTaskId(entry.metadata.task_id) === normalizedTaskId);

  if (matches.length === 0) {
    fail(`issue source ${absolutePath} does not contain a canonical task snapshot for ${taskId}`);
  }
  if (matches.length > 1) {
    fail(
      `issue source ${absolutePath} contains multiple canonical task snapshots for ${taskId}: ${matches.map((entry) => `#${entry.number}`).join(", ")}`
    );
  }

  return matches[0] as TaskIssueSnapshot;
}

export function buildCanonicalTaskSpec(snapshot: TaskIssueSnapshot): TaskSpec {
  const rebuilt = tryBuildTaskSpecFromIssueSnapshot({
    title: snapshot.title,
    body: snapshot.body,
    metadata: snapshot.metadata,
  });
  if (!rebuilt.spec || rebuilt.errors.length > 0) {
    fail(
      `canonical task snapshot #${snapshot.number} could not be rebuilt into a normalized task spec:\n${rebuilt.errors
        .map((error) => `- ${error}`)
        .join("\n")}`
    );
  }
  return rebuilt.spec;
}

export function normalizeTitleFromIssueTitle(title: string): string {
  const trimmed = String(title || "").trim();
  if (!trimmed) {
    return "";
  }
  return trimmed;
}
