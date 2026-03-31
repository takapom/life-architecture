import { fail, type JsonObject } from "../adapters/cli";
import type { TaskIssue, TaskMetadata } from "./issue-graph-types";
import {
  parseBulletProseListValue,
  parseChecklistProseListValue,
  parseTokenListValue,
} from "./list-field-parse";

export type TaskSpec = {
  task_id: string;
  title: string;
  summary: string;
  background: string;
  runtime_invariants: string[];
  ownership_sot: string[];
  task_type: string;
  status: string;
  priority: number;
  admission_mode: "standard" | "landing-exclusive" | "global-exclusive";
  global_invariant: string;
  unfreeze_condition: string;
  allowed_files: string[];
  acceptance_checks: string[];
  tests: string[];
  non_goals: string[];
  forbidden_shortcuts: string[];
  commit_units: string[];
  reviewer_outcomes: string[];
  canonical_gap: string;
  canonical_gap_owner: string;
  canonical_gap_review_date: string;
  canonical_deferral_reason: string;
  canonical_deferral_condition: string;
  task_sizing_exception: string;
  task_sizing_exception_type: string;
  task_sizing_split_failure: string;
  task_sizing_exception_reviewer_attestation: string;
  task_sizing_unsafe_state: string;
  task_sizing_affected_invariant: string;
  task_sizing_atomic_boundary: string;
  acceptance_criteria: string[];
  proof_tests: string[];
  rca_scope: string;
};

type RawTaskIssueSnapshot = {
  title: string;
  body: string;
  metadata: TaskMetadata;
};

type RebuiltTaskScopeSnapshot = {
  task_id: string;
  admission_mode: "standard" | "landing-exclusive" | "global-exclusive";
  global_invariant: string;
  unfreeze_condition: string;
  allowed_files: string[];
  acceptance_checks: string[];
  tests: string[];
  deps: string[];
};

export type ReadAfterWriteComparableIssue = Pick<
  TaskIssue,
  "number" | "title" | "state" | "metadata"
>;

const TASK_ID_PATTERN = /^[A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*-\d{3,}[a-z]?$/;
const TASK_TYPES = new Set(["feature", "bugfix", "refactor", "ops", "docs", "chore"]);
const KANBAN_STATUSES = new Set(["backlog", "ready", "in progress", "in review", "done"]);
const TASK_ADMISSION_MODES = new Set(["standard", "landing-exclusive", "global-exclusive"]);

const BODY_SECTION_ALIASES = {
  summary: ["summary"],
  background: ["background / context", "background"],
  runtimeInvariants: ["runtime invariants"],
  ownershipSot: ["ownership / sot", "ownership"],
  taskType: ["task type", "task_type"],
  priority: ["priority"],
  admissionMode: ["admission mode", "admission_mode"],
  globalInvariant: ["global invariant", "global_invariant"],
  unfreezeCondition: ["unfreeze condition", "unfreeze_condition"],
  allowedFiles: ["allowed files"],
  acceptanceChecks: ["acceptance checks"],
  tests: ["tests"],
  nonGoals: ["non-goals", "non goals"],
  forbiddenShortcuts: ["forbidden shortcuts"],
  commitUnits: ["commit units"],
  reviewerOutcomes: ["reviewer outcomes"],
  canonicalGap: ["canonical gap"],
  canonicalGapOwner: ["canonical gap owner"],
  canonicalGapReviewDate: ["canonical gap review date"],
  canonicalDeferralReason: ["canonical deferral reason"],
  canonicalDeferralCondition: ["canonical deferral condition"],
  taskSizingException: ["task sizing exception"],
  taskSizingExceptionType: ["task sizing exception type"],
  taskSizingSplitFailure: ["task sizing split failure"],
  taskSizingExceptionReviewerAttestation: ["task sizing exception reviewer attestation"],
  taskSizingUnsafeState: ["task sizing unsafe state"],
  taskSizingAffectedInvariant: ["task sizing affected invariant"],
  taskSizingAtomicBoundary: ["task sizing atomic boundary"],
  acceptanceCriteria: ["acceptance criteria"],
  proofTests: ["proof tests"],
  rcaScope: ["rca / impact scope", "rca scope"],
} as const;

const DEPRECATED_PROJECT_OWNED_BODY_SECTIONS = ["Task ID", "Status"] as const;

function ensureObject(value: unknown, field: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${field} must be an object`);
  }
  return value as JsonObject;
}

function ensureString(value: unknown, field: string): string {
  if (typeof value !== "string") fail(`${field} must be a string`);
  const text = value.trim();
  if (!text) fail(`${field} must not be empty`);
  return text;
}

function ensureStringArray(value: unknown, field: string, required = true): string[] {
  if (!Array.isArray(value)) {
    if (required) fail(`${field} must be an array of strings`);
    return [];
  }
  const items = value.map((entry) => String(entry || "").trim()).filter(Boolean);
  if (required && items.length === 0) {
    fail(`${field} must not be empty`);
  }
  return [...new Set(items)];
}

function parsePositiveInteger(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    fail(`${field} must be a positive integer`);
  }
  return parsed;
}

function normalizeChecklistItems(values: string[]): string[] {
  return values.map((entry) =>
    entry
      .replace(/^[-*+]\s+\[[ xX]\]\s+/, "")
      .replace(/^\[[ xX]\]\s+/, "")
      .replace(/^[-*+]\s+/, "")
      .trim()
  );
}

function listToBullet(values: string[]): string {
  if (values.length === 0) return "- _No response_";
  return values.map((entry) => `- ${entry}`).join("\n");
}

function listToChecklist(values: string[]): string {
  if (values.length === 0) return "- [ ] _No response_";
  return values.map((entry) => `- [ ] ${entry}`).join("\n");
}

function describeList(values: string[]): string {
  if (values.length === 0) return "(empty)";
  return values.join(" | ");
}

function pushScalarMismatch(
  mismatches: string[],
  field: string,
  expected: string,
  actual: string
): void {
  if (expected === actual) return;
  mismatches.push(
    `${field} mismatch (expected='${expected || "(empty)"}', actual='${actual || "(empty)"}')`
  );
}

function pushListMismatch(
  mismatches: string[],
  field: string,
  expected: string[],
  actual: string[]
): void {
  if (
    expected.length === actual.length &&
    expected.every((entry, index) => entry === actual[index])
  ) {
    return;
  }
  mismatches.push(
    `${field} mismatch (expected='${describeList(expected)}', actual='${describeList(actual)}')`
  );
}

function normalizeSectionName(value: string): string {
  return value.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

function parseIssueBodySections(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = String(body || "")
    .replace(/\r\n/g, "\n")
    .split("\n");
  let currentHeading = "";
  let sectionLines: string[] = [];

  const flush = () => {
    const key = normalizeSectionName(currentHeading);
    if (!key || out[key] !== undefined) return;
    out[key] = sectionLines.join("\n").trim();
  };

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+?)\s*$/);
    if (headingMatch) {
      flush();
      currentHeading = headingMatch[1] ?? "";
      sectionLines = [];
      continue;
    }
    sectionLines.push(line);
  }
  flush();

  return out;
}

function pickSectionValue(sections: Record<string, string>, aliases: readonly string[]): string {
  for (const alias of aliases) {
    const key = normalizeSectionName(alias);
    if (key in sections) {
      return String(sections[key] || "").trim();
    }
  }
  return "";
}

function parseBodyScalarValue(value: string): string {
  const normalized = String(value || "").trim();
  return !normalized || normalized === "_No response_" || normalized === "N/A" ? "" : normalized;
}

function parseBodyProseListValue(value: string): string[] {
  return parseBulletProseListValue(value);
}

function parseBodyChecklistProseListValue(value: string): string[] {
  return parseChecklistProseListValue(value);
}

function parseBodyTokenListValue(value: string): string[] {
  return parseTokenListValue(value);
}

function normalizeOptionalScalarValue(value: unknown): string {
  const normalized = String(value ?? "").trim();
  return !normalized || normalized === "_No response_" || normalized.toUpperCase() === "N/A"
    ? ""
    : normalized;
}

function parseOptionalTaskSizingValue(value: unknown): string {
  return normalizeOptionalScalarValue(value);
}

function deriveSummaryFromTitle(title: string, taskId: string): string {
  const matched = String(title || "")
    .trim()
    .match(/^\[TASK\]\s+([A-Z0-9-]+):\s+(.+)$/);
  if (!matched) return "";
  if (String(matched[1] || "").trim() !== taskId) return "";
  return String(matched[2] || "").trim();
}

function deriveTaskIdFromTitle(title: string): string {
  const matched = String(title || "")
    .trim()
    .match(/^\[TASK\]\s+([^:]+):/);
  return String(matched?.[1] || "").trim();
}

function resolveCanonicalTaskId(snapshot: RawTaskIssueSnapshot, errors: string[]): string {
  const taskIdFromMetadata = String(snapshot.metadata.task_id || "").trim();
  const taskIdFromTitle = deriveTaskIdFromTitle(snapshot.title);

  if (taskIdFromMetadata && taskIdFromTitle && taskIdFromMetadata !== taskIdFromTitle) {
    errors.push(
      `Task ID metadata/title mismatch (metadata='${taskIdFromMetadata}', title='${taskIdFromTitle}')`
    );
  }

  return taskIdFromTitle || taskIdFromMetadata;
}

export function normalizeIssueBodyForComparison(body: string): string {
  return String(body || "")
    .replace(/\r\n/g, "\n")
    .trim();
}

export function parseTaskSpec(raw: unknown): TaskSpec {
  const item = ensureObject(raw, "task_spec");
  if (Object.hasOwn(item, "taskId")) {
    fail("task_spec.taskId is unsupported (use task_id)");
  }
  if (Object.hasOwn(item, "taskType")) {
    fail("task_spec.taskType is unsupported (use task_type)");
  }

  const task_id = ensureString(item.task_id, "task_spec.task_id");
  if (!TASK_ID_PATTERN.test(task_id)) {
    fail(`task_spec.task_id is invalid: ${task_id}`);
  }

  const summary = ensureString(item.summary, "task_spec.summary");
  const background = ensureString(item.background, "task_spec.background");
  const runtime_invariants = ensureStringArray(
    item.runtime_invariants,
    "task_spec.runtime_invariants"
  );
  const ownership_sot = ensureStringArray(item.ownership_sot, "task_spec.ownership_sot");
  const task_type = ensureString(item.task_type, "task_spec.task_type").toLowerCase();
  if (!TASK_TYPES.has(task_type)) {
    fail(`task_spec.task_type must be one of: ${[...TASK_TYPES].join("|")}`);
  }
  const status = ensureString(item.status, "task_spec.status").toLowerCase();
  if (!KANBAN_STATUSES.has(status)) {
    fail(`task_spec.status must be one of: ${[...KANBAN_STATUSES].join("|")}`);
  }
  const priority = parsePositiveInteger(String(item.priority ?? ""), "task_spec.priority");
  const admission_mode = String(item.admission_mode || "standard")
    .trim()
    .toLowerCase();
  if (!TASK_ADMISSION_MODES.has(admission_mode)) {
    fail(`task_spec.admission_mode must be one of: ${[...TASK_ADMISSION_MODES].join("|")}`);
  }
  const global_invariant = normalizeOptionalScalarValue(item.global_invariant);
  const unfreeze_condition = normalizeOptionalScalarValue(item.unfreeze_condition);
  if (admission_mode === "global-exclusive") {
    if (!global_invariant) {
      fail("task_spec.global_invariant is required when task_spec.admission_mode=global-exclusive");
    }
    if (!unfreeze_condition) {
      fail(
        "task_spec.unfreeze_condition is required when task_spec.admission_mode=global-exclusive"
      );
    }
  } else if (global_invariant || unfreeze_condition) {
    fail(
      "task_spec.global_invariant and task_spec.unfreeze_condition must be empty when task_spec.admission_mode=standard|landing-exclusive"
    );
  }

  const allowed_files = ensureStringArray(item.allowed_files, "task_spec.allowed_files");
  const acceptance_checks = ensureStringArray(
    item.acceptance_checks,
    "task_spec.acceptance_checks"
  );
  const tests = ensureStringArray(item.tests, "task_spec.tests");
  const non_goals = ensureStringArray(item.non_goals, "task_spec.non_goals", false);
  const forbidden_shortcuts = ensureStringArray(
    item.forbidden_shortcuts,
    "task_spec.forbidden_shortcuts"
  );
  const commit_units = normalizeChecklistItems(
    ensureStringArray(item.commit_units, "task_spec.commit_units")
  );
  const reviewer_outcomes = normalizeChecklistItems(
    ensureStringArray(item.reviewer_outcomes ?? [summary], "task_spec.reviewer_outcomes")
  );
  const canonical_gap = parseOptionalTaskSizingValue(item.canonical_gap);
  const canonical_gap_owner = parseOptionalTaskSizingValue(item.canonical_gap_owner);
  const canonical_gap_review_date = parseOptionalTaskSizingValue(item.canonical_gap_review_date);
  const canonical_deferral_reason = parseOptionalTaskSizingValue(
    item.canonical_deferral_reason
  ).toLowerCase();
  const canonical_deferral_condition = parseOptionalTaskSizingValue(
    item.canonical_deferral_condition
  );
  const task_sizing_exception = parseOptionalTaskSizingValue(item.task_sizing_exception);
  const task_sizing_exception_type = parseOptionalTaskSizingValue(
    item.task_sizing_exception_type
  ).toLowerCase();
  const task_sizing_split_failure = parseOptionalTaskSizingValue(item.task_sizing_split_failure);
  const task_sizing_exception_reviewer_attestation = parseOptionalTaskSizingValue(
    item.task_sizing_exception_reviewer_attestation
  );
  const task_sizing_unsafe_state = parseOptionalTaskSizingValue(item.task_sizing_unsafe_state);
  const task_sizing_affected_invariant = parseOptionalTaskSizingValue(
    item.task_sizing_affected_invariant
  );
  const task_sizing_atomic_boundary = parseOptionalTaskSizingValue(
    item.task_sizing_atomic_boundary
  );
  const acceptance_criteria = normalizeChecklistItems(
    ensureStringArray(item.acceptance_criteria, "task_spec.acceptance_criteria")
  );
  const proof_tests = ensureStringArray(item.proof_tests, "task_spec.proof_tests");

  const rca_scope = normalizeOptionalScalarValue(item.rca_scope);
  if (task_type === "bugfix" && !rca_scope) {
    fail("task_spec.rca_scope is required when task_type=bugfix");
  }
  const title = String(item.title || "").trim() || `[TASK] ${task_id}: ${summary}`;

  return {
    task_id,
    title,
    summary,
    background,
    runtime_invariants,
    ownership_sot,
    task_type,
    status,
    priority,
    admission_mode: admission_mode as TaskSpec["admission_mode"],
    global_invariant,
    unfreeze_condition,
    allowed_files,
    acceptance_checks,
    tests,
    non_goals,
    forbidden_shortcuts,
    commit_units,
    reviewer_outcomes,
    canonical_gap,
    canonical_gap_owner,
    canonical_gap_review_date,
    canonical_deferral_reason,
    canonical_deferral_condition,
    task_sizing_exception,
    task_sizing_exception_type,
    task_sizing_split_failure,
    task_sizing_exception_reviewer_attestation,
    task_sizing_unsafe_state,
    task_sizing_affected_invariant,
    task_sizing_atomic_boundary,
    acceptance_criteria,
    proof_tests,
    rca_scope,
  };
}

export function renderIssueBody(spec: TaskSpec): string {
  return [
    "## Summary",
    spec.summary,
    "",
    "## Background / Context",
    spec.background,
    "",
    "## Runtime Invariants",
    listToBullet(spec.runtime_invariants),
    "",
    "## Ownership / SoT",
    listToBullet(spec.ownership_sot),
    "",
    "## Task Type",
    spec.task_type,
    "",
    "## Priority",
    String(spec.priority),
    "",
    "## Admission Mode",
    spec.admission_mode,
    "",
    "## Global Invariant",
    spec.global_invariant || "N/A",
    "",
    "## Unfreeze Condition",
    spec.unfreeze_condition || "N/A",
    "",
    "## Allowed Files",
    listToBullet(spec.allowed_files),
    "",
    "## Acceptance Checks",
    listToBullet(spec.acceptance_checks),
    "",
    "## Tests",
    listToBullet(spec.tests),
    "",
    "## Non-goals",
    listToBullet(spec.non_goals.length > 0 ? spec.non_goals : ["_No response_"]),
    "",
    "## Forbidden Shortcuts",
    listToBullet(spec.forbidden_shortcuts),
    "",
    "## Commit Units",
    listToChecklist(spec.commit_units),
    "",
    "## Reviewer Outcomes",
    listToBullet(spec.reviewer_outcomes),
    "",
    "## Canonical Gap",
    spec.canonical_gap || "N/A",
    "",
    "## Canonical Gap Owner",
    spec.canonical_gap_owner || "N/A",
    "",
    "## Canonical Gap Review Date",
    spec.canonical_gap_review_date || "N/A",
    "",
    "## Canonical Deferral Reason",
    spec.canonical_deferral_reason || "N/A",
    "",
    "## Canonical Deferral Condition",
    spec.canonical_deferral_condition || "N/A",
    "",
    "## Task Sizing Exception",
    spec.task_sizing_exception || "N/A",
    "",
    "## Task Sizing Exception Type",
    spec.task_sizing_exception_type || "N/A",
    "",
    "## Task Sizing Split Failure",
    spec.task_sizing_split_failure || "N/A",
    "",
    "## Task Sizing Exception Reviewer Attestation",
    spec.task_sizing_exception_reviewer_attestation || "N/A",
    "",
    "## Task Sizing Unsafe State",
    spec.task_sizing_unsafe_state || "N/A",
    "",
    "## Task Sizing Affected Invariant",
    spec.task_sizing_affected_invariant || "N/A",
    "",
    "## Task Sizing Atomic Boundary",
    spec.task_sizing_atomic_boundary || "N/A",
    "",
    "## Acceptance Criteria",
    listToChecklist(spec.acceptance_criteria),
    "",
    "## Proof Tests",
    listToBullet(spec.proof_tests),
    "",
    "## RCA / Impact Scope",
    spec.rca_scope || "_No response_",
  ].join("\n");
}

function pushOptionalScalarMismatch(
  mismatches: string[],
  field: string,
  expected: string,
  actual: string
): void {
  pushScalarMismatch(
    mismatches,
    field,
    normalizeOptionalScalarValue(expected),
    normalizeOptionalScalarValue(actual)
  );
}

export function collectTaskIssueReadAfterWriteMismatches(
  spec: TaskSpec,
  issue: ReadAfterWriteComparableIssue
): string[] {
  const mismatches: string[] = [];

  if (issue.state !== "open") {
    mismatches.push(`issue state mismatch (expected='open', actual='${issue.state || "(empty)"}')`);
  }

  pushScalarMismatch(mismatches, "title", spec.title, String(issue.title || "").trim());
  pushScalarMismatch(
    mismatches,
    "task_id",
    spec.task_id,
    String(issue.metadata.task_id || "").trim()
  );
  pushScalarMismatch(
    mismatches,
    "task_type",
    spec.task_type,
    String(issue.metadata.task_type || "").trim()
  );
  pushScalarMismatch(mismatches, "status", spec.status, String(issue.metadata.status || "").trim());
  pushScalarMismatch(
    mismatches,
    "admission_mode",
    spec.admission_mode,
    String(issue.metadata.admission_mode || "standard").trim()
  );
  pushOptionalScalarMismatch(
    mismatches,
    "global_invariant",
    spec.global_invariant,
    String(issue.metadata.global_invariant || "").trim()
  );
  pushOptionalScalarMismatch(
    mismatches,
    "unfreeze_condition",
    spec.unfreeze_condition,
    String(issue.metadata.unfreeze_condition || "").trim()
  );
  pushListMismatch(mismatches, "allowed_files", spec.allowed_files, issue.metadata.allowed_files);
  pushListMismatch(
    mismatches,
    "acceptance_checks",
    spec.acceptance_checks,
    issue.metadata.acceptance_checks
  );
  pushListMismatch(mismatches, "tests", spec.tests, issue.metadata.tests);
  pushListMismatch(mismatches, "non_goals", spec.non_goals, issue.metadata.non_goals);
  pushListMismatch(mismatches, "commit_units", spec.commit_units, issue.metadata.commit_units);
  pushListMismatch(
    mismatches,
    "reviewer_outcomes",
    spec.reviewer_outcomes,
    issue.metadata.reviewer_outcomes
  );
  pushOptionalScalarMismatch(
    mismatches,
    "canonical_gap",
    spec.canonical_gap,
    String(issue.metadata.canonical_gap || "").trim()
  );
  pushOptionalScalarMismatch(
    mismatches,
    "canonical_gap_owner",
    spec.canonical_gap_owner,
    String(issue.metadata.canonical_gap_owner || "").trim()
  );
  pushOptionalScalarMismatch(
    mismatches,
    "canonical_gap_review_date",
    spec.canonical_gap_review_date,
    String(issue.metadata.canonical_gap_review_date || "").trim()
  );
  pushOptionalScalarMismatch(
    mismatches,
    "canonical_deferral_reason",
    spec.canonical_deferral_reason,
    String(issue.metadata.canonical_deferral_reason || "").trim()
  );
  pushOptionalScalarMismatch(
    mismatches,
    "canonical_deferral_condition",
    spec.canonical_deferral_condition,
    String(issue.metadata.canonical_deferral_condition || "").trim()
  );
  pushOptionalScalarMismatch(
    mismatches,
    "task_sizing_exception",
    spec.task_sizing_exception,
    String(issue.metadata.task_sizing_exception || "").trim()
  );
  pushOptionalScalarMismatch(
    mismatches,
    "task_sizing_exception_type",
    spec.task_sizing_exception_type,
    String(issue.metadata.task_sizing_exception_type || "").trim()
  );
  pushOptionalScalarMismatch(
    mismatches,
    "task_sizing_split_failure",
    spec.task_sizing_split_failure,
    String(issue.metadata.task_sizing_split_failure || "").trim()
  );
  pushOptionalScalarMismatch(
    mismatches,
    "task_sizing_exception_reviewer_attestation",
    spec.task_sizing_exception_reviewer_attestation,
    String(issue.metadata.task_sizing_exception_reviewer_attestation || "").trim()
  );
  pushOptionalScalarMismatch(
    mismatches,
    "task_sizing_unsafe_state",
    spec.task_sizing_unsafe_state,
    String(issue.metadata.task_sizing_unsafe_state || "").trim()
  );
  pushOptionalScalarMismatch(
    mismatches,
    "task_sizing_affected_invariant",
    spec.task_sizing_affected_invariant,
    String(issue.metadata.task_sizing_affected_invariant || "").trim()
  );
  pushOptionalScalarMismatch(
    mismatches,
    "task_sizing_atomic_boundary",
    spec.task_sizing_atomic_boundary,
    String(issue.metadata.task_sizing_atomic_boundary || "").trim()
  );
  pushListMismatch(
    mismatches,
    "acceptance_criteria",
    spec.acceptance_criteria,
    issue.metadata.acceptance_criteria
  );
  pushOptionalScalarMismatch(
    mismatches,
    "rca_scope",
    spec.rca_scope,
    String(issue.metadata.rca_scope || "").trim()
  );

  return mismatches;
}

export function tryBuildTaskSpecFromIssueSnapshot(snapshot: RawTaskIssueSnapshot): {
  spec: TaskSpec | null;
  errors: string[];
} {
  const sections = parseIssueBodySections(snapshot.body);
  const metadata = snapshot.metadata;
  const errors: string[] = [];
  const taskId = resolveCanonicalTaskId(snapshot, errors);
  const summary =
    parseBodyScalarValue(pickSectionValue(sections, BODY_SECTION_ALIASES.summary)) ||
    deriveSummaryFromTitle(snapshot.title, taskId);
  const background = parseBodyScalarValue(
    pickSectionValue(sections, BODY_SECTION_ALIASES.background)
  );
  const runtimeInvariants = parseBodyProseListValue(
    pickSectionValue(sections, BODY_SECTION_ALIASES.runtimeInvariants)
  );
  const ownershipSot = parseBodyProseListValue(
    pickSectionValue(sections, BODY_SECTION_ALIASES.ownershipSot)
  );
  const forbiddenShortcuts = parseBodyProseListValue(
    pickSectionValue(sections, BODY_SECTION_ALIASES.forbiddenShortcuts)
  );
  const proofTests = parseBodyProseListValue(
    pickSectionValue(sections, BODY_SECTION_ALIASES.proofTests)
  );

  for (const heading of DEPRECATED_PROJECT_OWNED_BODY_SECTIONS) {
    if (Object.hasOwn(sections, normalizeSectionName(heading))) {
      errors.push(
        `${heading} section is unsupported in canonical task issue body (keep Project-owned board/runtime fields in Project-v2 only)`
      );
    }
  }

  if (!taskId) errors.push("Task ID is missing from issue metadata");
  if (!summary) errors.push("Summary section is missing");
  if (!background) errors.push("Background / Context section is missing");
  if (runtimeInvariants.length === 0) errors.push("Runtime Invariants section is missing");
  if (ownershipSot.length === 0) errors.push("Ownership / SoT section is missing");
  if (forbiddenShortcuts.length === 0) errors.push("Forbidden Shortcuts section is missing");
  if (proofTests.length === 0) errors.push("Proof Tests section is missing");

  if (errors.length > 0) {
    return { spec: null, errors };
  }

  try {
    const spec = parseTaskSpec({
      task_id: taskId,
      summary,
      background,
      runtime_invariants: runtimeInvariants,
      ownership_sot: ownershipSot,
      task_type:
        String(metadata.task_type || "").trim() ||
        parseBodyScalarValue(pickSectionValue(sections, BODY_SECTION_ALIASES.taskType)),
      status: String(metadata.status || "").trim(),
      priority:
        Number.isInteger(metadata.priority) && metadata.priority > 0
          ? metadata.priority
          : parseBodyScalarValue(pickSectionValue(sections, BODY_SECTION_ALIASES.priority)),
      admission_mode:
        String(metadata.admission_mode || "").trim() ||
        parseBodyScalarValue(pickSectionValue(sections, BODY_SECTION_ALIASES.admissionMode)) ||
        "standard",
      global_invariant:
        String(metadata.global_invariant || "").trim() ||
        parseBodyScalarValue(pickSectionValue(sections, BODY_SECTION_ALIASES.globalInvariant)),
      unfreeze_condition:
        String(metadata.unfreeze_condition || "").trim() ||
        parseBodyScalarValue(pickSectionValue(sections, BODY_SECTION_ALIASES.unfreezeCondition)),
      allowed_files:
        metadata.allowed_files.length > 0
          ? metadata.allowed_files
          : parseBodyTokenListValue(pickSectionValue(sections, BODY_SECTION_ALIASES.allowedFiles)),
      acceptance_checks:
        metadata.acceptance_checks.length > 0
          ? metadata.acceptance_checks
          : parseBodyProseListValue(
              pickSectionValue(sections, BODY_SECTION_ALIASES.acceptanceChecks)
            ),
      tests:
        metadata.tests.length > 0
          ? metadata.tests
          : parseBodyProseListValue(pickSectionValue(sections, BODY_SECTION_ALIASES.tests)),
      non_goals:
        metadata.non_goals.length > 0
          ? metadata.non_goals
          : parseBodyProseListValue(pickSectionValue(sections, BODY_SECTION_ALIASES.nonGoals)),
      forbidden_shortcuts: forbiddenShortcuts,
      commit_units:
        metadata.commit_units.length > 0
          ? metadata.commit_units
          : parseBodyChecklistProseListValue(
              pickSectionValue(sections, BODY_SECTION_ALIASES.commitUnits)
            ),
      reviewer_outcomes:
        metadata.reviewer_outcomes.length > 0
          ? metadata.reviewer_outcomes
          : parseBodyProseListValue(
              pickSectionValue(sections, BODY_SECTION_ALIASES.reviewerOutcomes)
            ),
      canonical_gap:
        metadata.canonical_gap ||
        parseBodyScalarValue(pickSectionValue(sections, BODY_SECTION_ALIASES.canonicalGap)),
      canonical_gap_owner:
        metadata.canonical_gap_owner ||
        parseBodyScalarValue(pickSectionValue(sections, BODY_SECTION_ALIASES.canonicalGapOwner)),
      canonical_gap_review_date:
        metadata.canonical_gap_review_date ||
        parseBodyScalarValue(
          pickSectionValue(sections, BODY_SECTION_ALIASES.canonicalGapReviewDate)
        ),
      canonical_deferral_reason:
        metadata.canonical_deferral_reason ||
        parseBodyScalarValue(
          pickSectionValue(sections, BODY_SECTION_ALIASES.canonicalDeferralReason)
        ),
      canonical_deferral_condition:
        metadata.canonical_deferral_condition ||
        parseBodyScalarValue(
          pickSectionValue(sections, BODY_SECTION_ALIASES.canonicalDeferralCondition)
        ),
      task_sizing_exception:
        metadata.task_sizing_exception ||
        parseBodyScalarValue(pickSectionValue(sections, BODY_SECTION_ALIASES.taskSizingException)),
      task_sizing_exception_type:
        metadata.task_sizing_exception_type ||
        parseBodyScalarValue(
          pickSectionValue(sections, BODY_SECTION_ALIASES.taskSizingExceptionType)
        ),
      task_sizing_split_failure:
        metadata.task_sizing_split_failure ||
        parseBodyScalarValue(
          pickSectionValue(sections, BODY_SECTION_ALIASES.taskSizingSplitFailure)
        ),
      task_sizing_exception_reviewer_attestation:
        metadata.task_sizing_exception_reviewer_attestation ||
        parseBodyScalarValue(
          pickSectionValue(sections, BODY_SECTION_ALIASES.taskSizingExceptionReviewerAttestation)
        ),
      task_sizing_unsafe_state:
        metadata.task_sizing_unsafe_state ||
        parseBodyScalarValue(
          pickSectionValue(sections, BODY_SECTION_ALIASES.taskSizingUnsafeState)
        ),
      task_sizing_affected_invariant:
        metadata.task_sizing_affected_invariant ||
        parseBodyScalarValue(
          pickSectionValue(sections, BODY_SECTION_ALIASES.taskSizingAffectedInvariant)
        ),
      task_sizing_atomic_boundary:
        metadata.task_sizing_atomic_boundary ||
        parseBodyScalarValue(
          pickSectionValue(sections, BODY_SECTION_ALIASES.taskSizingAtomicBoundary)
        ),
      acceptance_criteria:
        metadata.acceptance_criteria.length > 0
          ? metadata.acceptance_criteria
          : parseBodyChecklistProseListValue(
              pickSectionValue(sections, BODY_SECTION_ALIASES.acceptanceCriteria)
            ),
      proof_tests: proofTests,
      rca_scope:
        metadata.rca_scope ||
        parseBodyScalarValue(pickSectionValue(sections, BODY_SECTION_ALIASES.rcaScope)),
    });
    return { spec, errors: [] };
  } catch (error) {
    return {
      spec: null,
      errors: [
        `failed to rebuild canonical task spec from issue body: ${(error as Error).message}`,
      ],
    };
  }
}

export function tryBuildTaskScopeSnapshotFromIssueSnapshot(snapshot: RawTaskIssueSnapshot): {
  scope: RebuiltTaskScopeSnapshot | null;
  errors: string[];
} {
  const sections = parseIssueBodySections(snapshot.body);
  const errors: string[] = [];
  const taskId = resolveCanonicalTaskId(snapshot, errors);
  const allowedFiles =
    snapshot.metadata.allowed_files.length > 0
      ? snapshot.metadata.allowed_files
      : parseBodyTokenListValue(pickSectionValue(sections, BODY_SECTION_ALIASES.allowedFiles));
  const acceptanceChecks =
    snapshot.metadata.acceptance_checks.length > 0
      ? snapshot.metadata.acceptance_checks
      : parseBodyProseListValue(pickSectionValue(sections, BODY_SECTION_ALIASES.acceptanceChecks));
  const tests =
    snapshot.metadata.tests.length > 0
      ? snapshot.metadata.tests
      : parseBodyProseListValue(pickSectionValue(sections, BODY_SECTION_ALIASES.tests));

  if (!taskId) errors.push("Task ID is missing from issue metadata/title");
  if (allowedFiles.length === 0) errors.push("Allowed Files section is missing");
  if (acceptanceChecks.length === 0) errors.push("Acceptance Checks section is missing");
  if (tests.length === 0) errors.push("Tests section is missing");

  if (errors.length > 0) {
    return { scope: null, errors };
  }

  return {
    scope: {
      task_id: taskId,
      admission_mode: (() => {
        const normalized = String(snapshot.metadata.admission_mode || "")
          .trim()
          .toLowerCase();
        if (normalized === "global-exclusive") return "global-exclusive";
        if (normalized === "landing-exclusive") return "landing-exclusive";
        return "standard";
      })(),
      global_invariant: String(snapshot.metadata.global_invariant || "").trim(),
      unfreeze_condition: String(snapshot.metadata.unfreeze_condition || "").trim(),
      allowed_files: allowedFiles,
      acceptance_checks: acceptanceChecks,
      tests,
      deps: snapshot.metadata.deps,
    },
    errors: [],
  };
}
