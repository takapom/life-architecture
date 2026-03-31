import type { TaskMetadata } from "../../../core/task-governance-types";

export type JsonObject = Record<string, unknown>;

export type UpsertAction = "created" | "updated" | "create_planned" | "update_planned";
export type SubIssueLinkState = "not_requested" | "link_planned" | "linked" | "already_linked";
export type IssueReference = { issueNumber: number; repository: string };

export type UpsertTargetIssue = {
  number: number;
  url: string;
};

export type UpsertResult = {
  action: UpsertAction;
  repository: string;
  task_id: string;
  issue_number: number;
  issue_url: string;
  title: string;
  parent_issue_number?: number;
  sub_issue_link_state?: SubIssueLinkState;
};

export type IssuePayload = {
  title: string;
  body: string;
  labels: string[];
};

export type UpsertItem = {
  issue: IssuePayload;
  issueNumber: number;
  taskIdHint: string;
  parentIssueNumber: number;
};

export type RemoteTaskIssue = {
  number: number;
  title: string;
  body: string;
  url: string;
  labels?: string[];
  state?: string;
};

export type ParsedCli = {
  command: string;
  flags: Map<string, string | true>;
};

export const TASK_ID_VALUE_SOURCE = "[A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*-\\d{3,}[a-z]?";
export const TASK_ID_PATTERN = new RegExp(`^${TASK_ID_VALUE_SOURCE}$`);
export const TASK_ID_HINT_PATTERN = new RegExp(
  `(?:^|\\n)\\s*(?:[-*+]\\s*)?Task\\s*ID\\s*(?:[:\\-]\\s*|\\n+\\s*)(?:\\x60)?(${TASK_ID_VALUE_SOURCE})(?:\\x60)?`,
  "im"
);
export const TASK_ID_SEARCH_PATTERN = new RegExp(TASK_ID_VALUE_SOURCE, "m");
export const TASK_SEARCH_RESULT_LIMIT = 1_000;
export const REST_ISSUES_PAGE_SIZE = 100;

export function buildSeparatedSurfaceValidationMetadata(taskId: string): TaskMetadata {
  return {
    task_id: taskId,
    task_type: "ops",
    status: "backlog",
    run_id: "",
    claimed_by: "",
    lease_expires_at: "",
    priority: 1,
    deps: [],
    allowed_files: [],
    acceptance_checks: [],
    tests: [],
    non_goals: [],
    commit_units: [],
    reviewer_outcomes: [],
    canonical_gap: "",
    canonical_gap_owner: "",
    canonical_gap_review_date: "",
    canonical_deferral_reason: "",
    canonical_deferral_condition: "",
    task_sizing_exception: "",
    task_sizing_exception_type: "",
    task_sizing_split_failure: "",
    task_sizing_exception_reviewer_attestation: "",
    task_sizing_unsafe_state: "",
    task_sizing_affected_invariant: "",
    task_sizing_atomic_boundary: "",
    acceptance_criteria: [],
    rca_scope: "",
  };
}
