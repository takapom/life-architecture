import { execFileSync } from "node:child_process";
import {
  parseBulletProseListValue,
  parseChecklistProseListValue,
  parseTokenListValue,
} from "./list-field-parse";

export const TASK_ID_PATTERN = /^[A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*-\d{3,}[a-z]?$/;
export const VALID_STATUSES = new Set(["backlog", "ready", "in progress", "in review", "done"]);
export const VALID_TYPES = new Set(["feature", "bugfix", "refactor", "ops", "docs", "chore"]);
const RETIRED_PROJECT_NUMBER_ENV_KEYS = [
  "ISSUE_GRAPH_PROJECT_NUMBER",
  "ISSUE_DAG_PROJECT_NUMBER",
  "ORCHESTRATE_PROJECT_NUMBER",
] as const;
const GITHUB_SSH_RE = /^git@github\.com:(?<owner>[^/\s]+)\/(?<repo>[^/\s]+?)(?:\.git)?$/;
const GITHUB_HTTPS_RE =
  /^https:\/\/github\.com\/(?<owner>[^/\s]+)\/(?<repo>[^/\s]+?)(?:\.git)?\/?$/;
const GITHUB_SSH_URL_RE =
  /^ssh:\/\/git@github\.com\/(?<owner>[^/\s]+)\/(?<repo>[^/\s]+?)(?:\.git)?\/?$/;

const CANONICAL_PROJECT_FIELD_ALIASES = {
  taskId: ["task id", "task_id"],
  taskType: ["task type", "task_type"],
  status: ["status"],
  runId: ["run id", "run_id"],
  claimedBy: ["claimed by", "claimed_by"],
  leaseExpiresAt: ["lease expires at", "lease_expires_at"],
  priority: ["priority"],
} as const;

const RETIRED_TASK_SPEC_FIELD_ALIASES = {
  taskType: ["task type", "task_type"],
  priority: ["priority"],
  admissionMode: ["admission mode", "admission_mode"],
  globalInvariant: ["global invariant", "global_invariant"],
  unfreezeCondition: ["unfreeze condition", "unfreeze_condition"],
  allowedFiles: ["allowed files", "allowed_files"],
  acceptanceChecks: ["acceptance checks", "acceptance_checks"],
  tests: ["tests"],
  nonGoals: ["non-goals", "non goals", "non_goals"],
  commitUnits: ["commit units", "commit_units"],
  reviewerOutcomes: ["reviewer outcomes", "reviewer_outcomes"],
  canonicalGap: ["canonical gap", "canonical_gap"],
  canonicalGapOwner: ["canonical gap owner", "canonical_gap_owner"],
  canonicalGapReviewDate: ["canonical gap review date", "canonical_gap_review_date"],
  canonicalDeferralReason: ["canonical deferral reason", "canonical_deferral_reason"],
  canonicalDeferralCondition: ["canonical deferral condition", "canonical_deferral_condition"],
  taskSizingException: ["task sizing exception", "task_sizing_exception"],
  taskSizingExceptionType: ["task sizing exception type", "task_sizing_exception_type"],
  taskSizingSplitFailure: ["task sizing split failure", "task_sizing_split_failure"],
  taskSizingExceptionReviewerAttestation: [
    "task sizing exception reviewer attestation",
    "task_sizing_exception_reviewer_attestation",
  ],
  taskSizingUnsafeState: ["task sizing unsafe state", "task_sizing_unsafe_state"],
  taskSizingAffectedInvariant: ["task sizing affected invariant", "task_sizing_affected_invariant"],
  taskSizingAtomicBoundary: ["task sizing atomic boundary", "task_sizing_atomic_boundary"],
  acceptanceCriteria: ["acceptance criteria", "acceptance_criteria"],
  rcaScope: ["rca / impact scope", "rca scope", "rca_scope"],
} as const;

type ProjectFieldValue = string | number | string[];

type ProjectFieldMap = Record<string, ProjectFieldValue>;

export type IssueState = "open" | "closed";

export type TaskMetadata = {
  task_id: string;
  task_type: string;
  status: string;
  run_id: string;
  claimed_by: string;
  lease_expires_at: string;
  priority: number;
  deps: string[];
  admission_mode?: "standard" | "landing-exclusive" | "global-exclusive";
  global_invariant?: string;
  unfreeze_condition?: string;
  allowed_files: string[];
  acceptance_checks: string[];
  tests: string[];
  non_goals: string[];
  commit_units: string[];
  reviewer_outcomes: string[];
  canonical_gap?: string;
  canonical_gap_owner?: string;
  canonical_gap_review_date?: string;
  canonical_deferral_reason?: string;
  canonical_deferral_condition?: string;
  task_sizing_exception?: string;
  task_sizing_exception_type?: string;
  task_sizing_split_failure?: string;
  task_sizing_exception_reviewer_attestation?: string;
  task_sizing_unsafe_state?: string;
  task_sizing_affected_invariant?: string;
  task_sizing_atomic_boundary?: string;
  acceptance_criteria: string[];
  rca_scope: string;
};

export type TaskIssue = {
  id: string;
  number: number;
  title: string;
  state: IssueState;
  htmlUrl: string;
  labels: string[];
  metadata: TaskMetadata;
  dependencySource: "native-issue-link" | "none";
  graph: {
    blockedBy: number[];
    parent: number | null;
    subIssues: number[];
  };
};

export type AdmissionConflict = {
  left_task_id: string;
  left_issue_number: number;
  left_pattern: string;
  right_task_id: string;
  right_issue_number: number;
  right_pattern: string;
  scope: "serialized_scope" | "resource_claim" | "hot_root" | "global_exclusive" | "commit_unit";
};

export type ValidationResult = {
  errors: string[];
  warnings: string[];
  ready: TaskIssue[];
  open: TaskIssue[];
  done: TaskIssue[];
  admission_conflicts: AdmissionConflict[];
};

export type GraphIssueNode = {
  id?: string;
  number: number;
  title: string;
  state: string;
  url?: string;
  html_url?: string;
  body?: string | null;
  labels?:
    | Array<string | { name?: string }>
    | {
        nodes?: Array<{ name?: string }>;
      };
  blockedBy?: { nodes?: Array<{ number?: number }> } | number[] | Array<{ number?: number }>;
  parent?: { number?: number } | null;
  subIssues?: { nodes?: Array<{ number?: number }> } | number[] | Array<{ number?: number }>;
  project_fields?: Record<string, unknown>;
  projectItems?: {
    nodes?: Array<{
      project?: { id?: string; number?: number; title?: string } | null;
      fieldValues?: {
        nodes?: Array<{
          text?: string;
          number?: number;
          name?: string;
          title?: string;
          field?: { name?: string };
        }>;
      };
    }>;
  };
  pull_request?: Record<string, unknown>;
};

export type RepositoryRef = {
  owner: string;
  repo: string;
};

export function normalizePathPattern(value: string): string {
  return value.replace(/^\.\//, "").replace(/\\/g, "/").trim();
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function normalizePriority(raw: unknown): number {
  const text = String(raw ?? "").trim();
  if (!text) return 100;
  const singleSelectMatch = text.match(/^P(\d+)$/i);
  if (singleSelectMatch) {
    return Math.max(0, Math.trunc(Number(singleSelectMatch[1] || "0")));
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) return 100;
  return Math.max(0, Math.trunc(value));
}

function parseRepository(raw: string): RepositoryRef {
  const value = raw.trim();
  const parts = value.split("/").filter(Boolean);
  if (parts.length !== 2) {
    throw new Error(`invalid repository format (<owner>/<repo>): ${raw}`);
  }
  return { owner: parts[0], repo: parts[1] };
}

function parseRepositoryFromOriginUrl(raw: string): RepositoryRef {
  const value = String(raw || "").trim();
  if (!value) {
    throw new Error("git remote origin url is empty");
  }

  for (const pattern of [GITHUB_SSH_RE, GITHUB_HTTPS_RE, GITHUB_SSH_URL_RE]) {
    const matched = value.match(pattern);
    if (!matched?.groups?.owner || !matched.groups.repo) continue;
    return {
      owner: matched.groups.owner,
      repo: matched.groups.repo,
    };
  }

  throw new Error(`failed to resolve owner/repo from git remote origin: ${value}`);
}

function detectRepositoryFromOrigin(cwd = process.cwd()): RepositoryRef {
  const originUrl = execFileSync("git", ["-C", cwd, "config", "--get", "remote.origin.url"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  return parseRepositoryFromOriginUrl(originUrl);
}

export function parseIssueState(raw: string): IssueState {
  const normalized = String(raw || "")
    .trim()
    .toLowerCase();
  return normalized === "closed" ? "closed" : "open";
}

export function extractLabels(raw: GraphIssueNode["labels"]): string[] {
  if (!raw) return [];

  if (Array.isArray(raw)) {
    return uniqueStrings(
      raw
        .map((entry) => {
          if (typeof entry === "string") return entry;
          return String(entry.name ?? "");
        })
        .filter(Boolean)
    );
  }

  const nodes = Array.isArray(raw.nodes) ? raw.nodes : [];
  return uniqueStrings(nodes.map((entry) => String(entry?.name ?? "").trim()).filter(Boolean));
}

export function extractIssueNumbers(raw: unknown): number[] {
  if (!raw) return [];

  const out: number[] = [];
  const seen = new Set<number>();

  const push = (value: unknown): void => {
    const num = Number(value);
    if (!Number.isInteger(num) || num <= 0 || seen.has(num)) return;
    seen.add(num);
    out.push(num);
  };

  const fromArray = (items: unknown[]): void => {
    for (const item of items) {
      if (typeof item === "number") {
        push(item);
        continue;
      }
      if (item && typeof item === "object") {
        push((item as { number?: unknown }).number);
      }
    }
  };

  if (Array.isArray(raw)) {
    fromArray(raw);
    return out;
  }

  if (raw && typeof raw === "object") {
    const nodes = (raw as { nodes?: unknown[] }).nodes;
    if (Array.isArray(nodes)) {
      fromArray(nodes);
    }
  }

  return out;
}

function normalizeProjectFieldName(value: string): string {
  return value.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

function toProjectFieldMapFromObject(raw: unknown): ProjectFieldMap {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: ProjectFieldMap = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const normalizedKey = normalizeProjectFieldName(key);
    if (!normalizedKey) continue;
    if (Array.isArray(value)) {
      out[normalizedKey] = value.map((entry) => String(entry || "").trim()).filter(Boolean);
      continue;
    }
    if (typeof value === "number") {
      out[normalizedKey] = value;
      continue;
    }
    const text = String(value ?? "").trim();
    out[normalizedKey] = text;
  }
  return out;
}

function toProjectFieldMapFromIssueBody(rawBody: string | null | undefined): ProjectFieldMap {
  const body = String(rawBody || "").trim();
  if (!body) return {};

  const out: ProjectFieldMap = {};
  const lines = body.split(/\r?\n/);
  let currentHeading = "";
  let sectionLines: string[] = [];

  const flushSection = () => {
    const normalizedHeading = normalizeProjectFieldName(currentHeading);
    if (!normalizedHeading) return;
    if (out[normalizedHeading] !== undefined) return;

    const content = sectionLines.join("\n").trim();
    if (!content || content === "_No response_") return;
    out[normalizedHeading] = content;
  };

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+?)\s*$/);
    if (headingMatch) {
      flushSection();
      currentHeading = headingMatch[1] ?? "";
      sectionLines = [];
      continue;
    }
    sectionLines.push(line);
  }
  flushSection();

  return out;
}

export function extractTaskIdFromIssueBody(rawBody: string | null | undefined): string {
  const issueBodyFieldMap = toProjectFieldMapFromIssueBody(rawBody);
  return parseScalarValue(
    pickProjectField(issueBodyFieldMap, CANONICAL_PROJECT_FIELD_ALIASES.taskId)
  ).trim();
}

export function extractTaskIdFromIssueTitle(rawTitle: string | null | undefined): string {
  const matched = String(rawTitle || "")
    .trim()
    .match(/^\[TASK\]\s+([^:]+):/);
  return String(matched?.[1] || "").trim();
}

function toProjectFieldMapFromProjectItems(raw: GraphIssueNode["projectItems"]): ProjectFieldMap {
  const items = Array.isArray(raw?.nodes) ? raw.nodes : [];
  const out: ProjectFieldMap = {};

  for (const item of items) {
    const fieldValues = Array.isArray(item?.fieldValues?.nodes) ? item.fieldValues.nodes : [];
    for (const fieldValue of fieldValues) {
      if (!fieldValue || typeof fieldValue !== "object") continue;
      const fieldName = normalizeProjectFieldName(String(fieldValue.field?.name || ""));
      if (!fieldName) continue;

      const textValue = String(fieldValue.text || "").trim();
      const selectValue = String(fieldValue.name || "").trim();
      const iterationValue = String(fieldValue.title || "").trim();
      const numberValue =
        typeof fieldValue.number === "number" && Number.isFinite(fieldValue.number)
          ? fieldValue.number
          : null;

      let resolved: ProjectFieldValue | null = null;
      if (textValue) {
        resolved = textValue;
      } else if (selectValue) {
        resolved = selectValue;
      } else if (iterationValue) {
        resolved = iterationValue;
      } else if (numberValue !== null) {
        resolved = numberValue;
      }

      if (resolved === null || out[fieldName] !== undefined) continue;
      out[fieldName] = resolved;
    }
  }

  return out;
}

function mergeProjectFieldMaps(...maps: ProjectFieldMap[]): ProjectFieldMap {
  const merged: ProjectFieldMap = {};
  for (const source of maps) {
    for (const [key, value] of Object.entries(source)) {
      if (merged[key] !== undefined) continue;
      merged[key] = value;
    }
  }
  return merged;
}

function pickProjectField(
  map: ProjectFieldMap,
  aliases: readonly string[]
): ProjectFieldValue | null {
  for (const alias of aliases) {
    const normalized = normalizeProjectFieldName(alias);
    if (normalized in map) {
      return map[normalized] ?? null;
    }
  }
  return null;
}

function parseScalarValue(value: ProjectFieldValue | null): string {
  if (value === null) return "";
  if (Array.isArray(value)) {
    return String(value[0] || "").trim();
  }
  return String(value || "").trim();
}

function parseOptionalScalarValue(value: ProjectFieldValue | null): string {
  const normalized = parseScalarValue(value);
  return normalized.toUpperCase() === "N/A" ? "" : normalized;
}

function parseIsoInstant(value: string): Date | null {
  const text = String(value || "").trim();
  if (!text) return null;
  const time = Date.parse(text);
  if (!Number.isFinite(time)) return null;
  return new Date(time);
}

function normalizeClaimOwner(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase();
}

export function hasActiveForeignClaim(
  metadata: TaskMetadata,
  options: {
    sessionId?: string;
    runId?: string;
    now?: Date;
  } = {}
): boolean {
  if (
    String(metadata.status || "")
      .trim()
      .toLowerCase() !== "in progress"
  )
    return false;
  const claimOwner = normalizeClaimOwner(metadata.claimed_by);
  const currentSession = normalizeClaimOwner(options.sessionId || "");
  const requestedRunId = String(options.runId || "").trim();
  const currentRunId = String(metadata.run_id || "").trim();
  const leaseMissingOrInvalid = !parseIsoInstant(metadata.lease_expires_at);
  const now = options.now || new Date();
  const leaseExpiresAt = parseIsoInstant(metadata.lease_expires_at);
  const leaseIsActive = Boolean(leaseExpiresAt && leaseExpiresAt.getTime() > now.getTime());

  if (claimOwner) {
    if (currentSession && claimOwner === currentSession) {
      if (requestedRunId && currentRunId && currentRunId !== requestedRunId) {
        return leaseMissingOrInvalid || leaseIsActive;
      }
      return false;
    }
    return leaseMissingOrInvalid || leaseIsActive;
  }

  if (requestedRunId && currentRunId && currentRunId !== requestedRunId) {
    return leaseMissingOrInvalid || leaseIsActive;
  }
  return false;
}

export function assertNoRetiredProjectNumberEnv(): void {
  for (const key of RETIRED_PROJECT_NUMBER_ENV_KEYS) {
    // biome-ignore lint/style/noProcessEnv: retired env detection must inspect the live process environment to fail closed.
    const retiredValue = String(process.env[key] || "").trim();
    if (!retiredValue) continue;
    throw new Error(
      `${key} is retired; issue-only task resolution no longer accepts project-number filtering`
    );
  }
}

export function resolveExpectedProjectNumber(): number {
  assertNoRetiredProjectNumberEnv();
  return 0;
}

export function parseTaskMetadata(raw: {
  issueNumber: number;
  title: string;
  state: IssueState;
  labels: string[];
  source: GraphIssueNode;
}): TaskMetadata {
  const projectItemFieldMap = toProjectFieldMapFromProjectItems(raw.source.projectItems);
  const projectFieldPayloadMap = toProjectFieldMapFromObject(raw.source.project_fields);
  const metadataFieldPayloadMap = toProjectFieldMapFromObject(
    (raw.source as Record<string, unknown>).metadata
  );
  const issueBodyFieldMap = toProjectFieldMapFromIssueBody(raw.source.body);

  const canonicalProjectFieldMap = mergeProjectFieldMaps(
    projectItemFieldMap,
    projectFieldPayloadMap,
    metadataFieldPayloadMap
  );
  const retiredTaskSpecFieldMap = mergeProjectFieldMaps(
    issueBodyFieldMap,
    projectItemFieldMap,
    projectFieldPayloadMap,
    metadataFieldPayloadMap
  );

  const runIdField = parseScalarValue(
    pickProjectField(canonicalProjectFieldMap, CANONICAL_PROJECT_FIELD_ALIASES.runId)
  );
  const claimedByField = parseScalarValue(
    pickProjectField(canonicalProjectFieldMap, CANONICAL_PROJECT_FIELD_ALIASES.claimedBy)
  );
  const leaseExpiresAtField = parseScalarValue(
    pickProjectField(canonicalProjectFieldMap, CANONICAL_PROJECT_FIELD_ALIASES.leaseExpiresAt)
  );
  const task_id = extractTaskIdFromIssueTitle(raw.title);
  const task_type = parseScalarValue(
    pickProjectField(canonicalProjectFieldMap, CANONICAL_PROJECT_FIELD_ALIASES.taskType) ??
      pickProjectField(retiredTaskSpecFieldMap, RETIRED_TASK_SPEC_FIELD_ALIASES.taskType)
  )
    .toLowerCase()
    .trim();
  const canonicalStatus = parseScalarValue(
    pickProjectField(canonicalProjectFieldMap, CANONICAL_PROJECT_FIELD_ALIASES.status)
  )
    .toLowerCase()
    .trim();
  const status = canonicalStatus || (raw.state === "closed" ? "done" : "backlog");
  const priority = normalizePriority(
    pickProjectField(canonicalProjectFieldMap, CANONICAL_PROJECT_FIELD_ALIASES.priority) ??
      pickProjectField(retiredTaskSpecFieldMap, RETIRED_TASK_SPEC_FIELD_ALIASES.priority)
  );

  const admission_mode_raw = parseOptionalScalarValue(
    pickProjectField(retiredTaskSpecFieldMap, RETIRED_TASK_SPEC_FIELD_ALIASES.admissionMode)
  )
    .toLowerCase()
    .trim();
  let admission_mode: "standard" | "landing-exclusive" | "global-exclusive" = "standard";
  if (admission_mode_raw === "global-exclusive") {
    admission_mode = "global-exclusive";
  } else if (admission_mode_raw === "landing-exclusive") {
    admission_mode = "landing-exclusive";
  }
  const global_invariant = parseOptionalScalarValue(
    pickProjectField(retiredTaskSpecFieldMap, RETIRED_TASK_SPEC_FIELD_ALIASES.globalInvariant)
  );
  const unfreeze_condition = parseOptionalScalarValue(
    pickProjectField(retiredTaskSpecFieldMap, RETIRED_TASK_SPEC_FIELD_ALIASES.unfreezeCondition)
  );
  const allowed_files = parseTokenListValue(
    pickProjectField(retiredTaskSpecFieldMap, RETIRED_TASK_SPEC_FIELD_ALIASES.allowedFiles)
  ).map(normalizePathPattern);
  const acceptance_checks = parseBulletProseListValue(
    pickProjectField(retiredTaskSpecFieldMap, RETIRED_TASK_SPEC_FIELD_ALIASES.acceptanceChecks)
  );
  const tests = parseBulletProseListValue(
    pickProjectField(retiredTaskSpecFieldMap, RETIRED_TASK_SPEC_FIELD_ALIASES.tests)
  );
  const non_goals = parseBulletProseListValue(
    pickProjectField(retiredTaskSpecFieldMap, RETIRED_TASK_SPEC_FIELD_ALIASES.nonGoals)
  );
  const commit_units = parseChecklistProseListValue(
    pickProjectField(retiredTaskSpecFieldMap, RETIRED_TASK_SPEC_FIELD_ALIASES.commitUnits)
  );
  const reviewer_outcomes = parseBulletProseListValue(
    pickProjectField(retiredTaskSpecFieldMap, RETIRED_TASK_SPEC_FIELD_ALIASES.reviewerOutcomes)
  );
  const canonical_gap = parseOptionalScalarValue(
    pickProjectField(retiredTaskSpecFieldMap, RETIRED_TASK_SPEC_FIELD_ALIASES.canonicalGap)
  );
  const canonical_gap_owner = parseOptionalScalarValue(
    pickProjectField(retiredTaskSpecFieldMap, RETIRED_TASK_SPEC_FIELD_ALIASES.canonicalGapOwner)
  );
  const canonical_gap_review_date = parseOptionalScalarValue(
    pickProjectField(
      retiredTaskSpecFieldMap,
      RETIRED_TASK_SPEC_FIELD_ALIASES.canonicalGapReviewDate
    )
  );
  const canonical_deferral_reason = parseOptionalScalarValue(
    pickProjectField(
      retiredTaskSpecFieldMap,
      RETIRED_TASK_SPEC_FIELD_ALIASES.canonicalDeferralReason
    )
  );
  const canonical_deferral_condition = parseOptionalScalarValue(
    pickProjectField(
      retiredTaskSpecFieldMap,
      RETIRED_TASK_SPEC_FIELD_ALIASES.canonicalDeferralCondition
    )
  );
  const task_sizing_exception = parseOptionalScalarValue(
    pickProjectField(retiredTaskSpecFieldMap, RETIRED_TASK_SPEC_FIELD_ALIASES.taskSizingException)
  );
  const task_sizing_exception_type = parseOptionalScalarValue(
    pickProjectField(
      retiredTaskSpecFieldMap,
      RETIRED_TASK_SPEC_FIELD_ALIASES.taskSizingExceptionType
    )
  );
  const task_sizing_split_failure = parseOptionalScalarValue(
    pickProjectField(
      retiredTaskSpecFieldMap,
      RETIRED_TASK_SPEC_FIELD_ALIASES.taskSizingSplitFailure
    )
  );
  const task_sizing_exception_reviewer_attestation = parseOptionalScalarValue(
    pickProjectField(
      retiredTaskSpecFieldMap,
      RETIRED_TASK_SPEC_FIELD_ALIASES.taskSizingExceptionReviewerAttestation
    )
  );
  const task_sizing_unsafe_state = parseOptionalScalarValue(
    pickProjectField(retiredTaskSpecFieldMap, RETIRED_TASK_SPEC_FIELD_ALIASES.taskSizingUnsafeState)
  );
  const task_sizing_affected_invariant = parseOptionalScalarValue(
    pickProjectField(
      retiredTaskSpecFieldMap,
      RETIRED_TASK_SPEC_FIELD_ALIASES.taskSizingAffectedInvariant
    )
  );
  const task_sizing_atomic_boundary = parseOptionalScalarValue(
    pickProjectField(
      retiredTaskSpecFieldMap,
      RETIRED_TASK_SPEC_FIELD_ALIASES.taskSizingAtomicBoundary
    )
  );
  const acceptance_criteria = parseChecklistProseListValue(
    pickProjectField(retiredTaskSpecFieldMap, RETIRED_TASK_SPEC_FIELD_ALIASES.acceptanceCriteria)
  );
  const rca_scope = parseScalarValue(
    pickProjectField(retiredTaskSpecFieldMap, RETIRED_TASK_SPEC_FIELD_ALIASES.rcaScope)
  );

  return {
    task_id,
    task_type,
    status,
    run_id: runIdField,
    claimed_by: claimedByField,
    lease_expires_at: leaseExpiresAtField,
    priority,
    deps: [],
    admission_mode,
    global_invariant,
    unfreeze_condition,
    allowed_files,
    acceptance_checks,
    tests,
    non_goals,
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
    rca_scope,
  };
}

export function normalizeSourceIssue(raw: GraphIssueNode): GraphIssueNode {
  return {
    id: String(raw.id || `ISSUE_${raw.number}`),
    number: Number(raw.number),
    title: String(raw.title || "").trim(),
    state: String(raw.state || "open"),
    url: String(raw.url || raw.html_url || ""),
    html_url: String(raw.html_url || raw.url || ""),
    body: String(raw.body ?? ""),
    labels: raw.labels,
    blockedBy: raw.blockedBy,
    parent: raw.parent,
    subIssues: raw.subIssues,
    project_fields: raw.project_fields,
    projectItems: raw.projectItems,
    pull_request: raw.pull_request,
  };
}

export function resolveRepository(value: string): RepositoryRef {
  const normalized = String(value || "").trim();
  if (normalized) {
    return parseRepository(normalized);
  }
  return detectRepositoryFromOrigin();
}

export function resolveGitHubToken(): string {
  // biome-ignore lint/style/noProcessEnv: gh auth fallback remains secondary to explicit process credentials in tooling.
  const envToken = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim();
  if (envToken) return envToken;

  try {
    const token = execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (token) return token;
  } catch {
    // fall through
  }

  throw new Error(
    "GitHub token was not found. Set GITHUB_TOKEN (or GH_TOKEN) or run `gh auth login` first."
  );
}
