#!/usr/bin/env bun

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import { Command } from "commander";

import { fail } from "../../adapters/cli";
import {
  collectTaskSizingFindings,
  currentGitBranch,
  detectRepositoryFromOrigin,
  extractTaskIdFromBranch,
  findForbiddenDesignDeferralLabels,
  normalizeTaskId,
} from "../../core/task-governance";
import {
  extractTaskIdFromIssueBody,
  extractTaskIdFromIssueTitle,
  type GraphIssueNode,
  normalizeSourceIssue,
  parseIssueState,
  parseTaskMetadata,
  type TaskMetadata,
} from "../../core/task-governance-types";
import { overlapsPathPattern } from "../../core/task-governance-validate";

const REQUIRED_TABLE_HEADERS = [
  "Acceptance Criteria (issue)",
  "Changed Files",
  "Validation (checks/tests)",
] as const;

const REQUIRED_CHECKLIST_ITEMS = [
  "対応Issueの Acceptance Criteria を全件マッピングした",
  "変更ファイルは Allowed Files の範囲内に収まっている",
  "全ての non-merge commit が宣言済み `CU<n>` にちょうど 1 つ紐づいている",
  "実行した検証コマンドを Acceptance Checks / Tests から記載した",
  "マッピングできない要件がある場合、実装前に Issue を更新した",
] as const;

type EventContext = {
  body: string;
  repository: string;
  pullNumber: number;
  headRef: string;
  authorLogin: string;
  pullRequestState: string;
  closingIssueNumbers: number[];
};

export type ExpectedTaskIssue = {
  taskId: string;
  issueNumber: number;
  issueUrl: string;
  admissionMode?: "standard" | "landing-exclusive" | "global-exclusive";
  globalInvariant?: string;
  unfreezeCondition?: string;
  allowedFiles?: string[];
  commitUnits?: string[];
  reviewerOutcomes?: string[];
  canonicalGap?: string;
  canonicalGapOwner?: string;
  canonicalGapReviewDate?: string;
  canonicalDeferralReason?: string;
  canonicalDeferralCondition?: string;
  taskSizingException?: string;
  taskSizingExceptionType?: string;
  taskSizingSplitFailure?: string;
  taskSizingExceptionReviewerAttestation?: string;
  taskSizingUnsafeState?: string;
  taskSizingAffectedInvariant?: string;
  taskSizingAtomicBoundary?: string;
};

export type PullRequestCommit = {
  sha: string;
  message: string;
  parentCount: number;
};

export type PrBodyTraceabilityOptions = {
  changedFiles?: string[];
  commits?: PullRequestCommit[];
  expectedTaskIssue?: ExpectedTaskIssue | null;
};

export type CommitTraceabilityOptions = {
  expectedTaskIssue: ExpectedTaskIssue;
};

export type CanonicalPrBodyInput = {
  acceptanceCriteria: string[];
  changeSummaryBullets: string[];
  changedFiles: string[];
  expectedTaskIssue: ExpectedTaskIssue;
  summary: string;
  tests: string[];
  title: string;
};

type TaskIssueCandidate = {
  number: number;
  body: string;
  taskId: string;
  url: string;
  metadata: Pick<
    TaskMetadata,
    | "allowed_files"
    | "admission_mode"
    | "global_invariant"
    | "unfreeze_condition"
    | "commit_units"
    | "reviewer_outcomes"
    | "canonical_gap"
    | "canonical_gap_owner"
    | "canonical_gap_review_date"
    | "canonical_deferral_reason"
    | "canonical_deferral_condition"
    | "task_sizing_exception"
    | "task_sizing_exception_type"
    | "task_sizing_split_failure"
    | "task_sizing_exception_reviewer_attestation"
    | "task_sizing_unsafe_state"
    | "task_sizing_affected_invariant"
    | "task_sizing_atomic_boundary"
  >;
};

type ResolveExpectedTaskIssueOptions = {
  closedLinkedIssues?: TaskIssueCandidate[];
};

export type PrBodyTraceabilityMode =
  | "canonical-task-pr"
  | "dependency-bot-managed-pr"
  | "unsupported-non-task-pr";

const CLOSING_KEYWORD_PATTERN = "close(?:s|d)?|fix(?:es|ed)?|resolve(?:s|d)?";
const GH_ISSUE_LIST_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
const GH_PR_COMMITS_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const DECLARED_COMMIT_UNIT_PATTERN = /\b(CU\d+)\b/i;
const COMMIT_UNIT_SUBJECT_PATTERN = /^\s*(CU\d+)\s*:/i;
const COMMIT_UNIT_TRAILER_SOURCE = "^(?:CU|Commit-Unit|Commit Unit)\\s*:\\s*(CU\\d+)\\s*$";

function normalizeHeadingCell(value: string): string {
  return value.replace(/[`*_]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeChecklistText(value: string): string {
  return value.replace(/`/g, "").replace(/\s+/g, " ").trim();
}

function normalizeFilePath(value: string): string {
  const trimmed = value
    .trim()
    .replace(/^\.\//, "")
    .replace(/^[,;]+/, "")
    .replace(/[,;]+$/, "");
  if (!trimmed) return "";
  if (trimmed === "-") return "";
  if (trimmed === "...") return "";
  if (/^例[:：]/.test(trimmed)) return "";
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return "";
  return trimmed;
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return [];
  const cells: string[] = [];
  let current = "";
  let inCodeSpan = false;
  let escaping = false;

  for (const char of trimmed.slice(1, -1)) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      current += char;
      escaping = true;
      continue;
    }
    if (char === "`") {
      inCodeSpan = !inCodeSpan;
      current += char;
      continue;
    }
    if (char === "|" && !inCodeSpan) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }

  cells.push(current.trim());
  return cells;
}

function extractTableBlocks(markdown: string): string[][] {
  const lines = markdown.split(/\r?\n/);
  const blocks: string[][] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (/^\s*\|.*\|\s*$/.test(line)) {
      current.push(line);
      continue;
    }

    if (current.length > 0) {
      blocks.push(current);
      current = [];
    }
  }

  if (current.length > 0) {
    blocks.push(current);
  }

  return blocks;
}

function findCoverageTableRows(markdown: string): string[][] | null {
  const headerKeys = REQUIRED_TABLE_HEADERS.map((header) => normalizeHeadingCell(header));

  for (const block of extractTableBlocks(markdown)) {
    if (block.length < 3) continue;
    const header = splitTableRow(block[0] ?? "");
    if (header.length !== REQUIRED_TABLE_HEADERS.length) continue;

    const normalizedHeader = header.map((cell) => normalizeHeadingCell(cell));
    const matched = normalizedHeader.every((cell, index) => cell === headerKeys[index]);
    if (!matched) continue;

    return block.map((line) => splitTableRow(line));
  }

  return null;
}

function isPlaceholderCell(value: string): boolean {
  return normalizeFilePath(value) === "";
}

function collectChecklistItems(markdown: string): Array<{ checked: boolean; text: string }> {
  const out: Array<{ checked: boolean; text: string }> = [];
  const pattern = /^\s*-\s*\[( |x|X)\]\s*(.+?)\s*$/gm;

  for (const match of markdown.matchAll(pattern)) {
    const state = (match[1] ?? "").toLowerCase();
    const text = normalizeChecklistText(match[2] ?? "");
    if (!text) continue;
    out.push({ checked: state === "x", text });
  }

  return out;
}

function parseChangedFilesCell(value: string): string[] {
  const files = new Set<string>();

  for (const match of value.matchAll(/`([^`]+)`/g)) {
    const raw = match[1] ?? "";
    for (const token of raw.split(/[,\n]/)) {
      const normalized = normalizeFilePath(token);
      if (!normalized) continue;
      files.add(normalized);
    }
  }

  return [...files];
}

function normalizeChangedFiles(values: string[]): string[] {
  const out = new Set<string>();
  for (const value of values) {
    const normalized = normalizeFilePath(value);
    if (!normalized) continue;
    out.add(normalized);
  }
  return [...out].sort();
}

function normalizeStringArray(values: unknown, normalizer: (value: string) => string): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  return [...new Set(values.map((value) => normalizer(String(value || ""))).filter(Boolean))];
}

function normalizeBodyText(value: string): string {
  return String(value || "")
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeTableCellText(value: string): string {
  return normalizeBodyText(value).replaceAll("|", "\\|");
}

function escapeInlineCode(value: string): string {
  return normalizeBodyText(value).replaceAll("`", "\\`");
}

function stripTaskPrefix(title: string): string {
  const trimmed = String(title || "").trim();
  const matched = trimmed.match(/^\[TASK\]\s+[^:]+:\s*(.+)$/i);
  if (matched?.[1]) {
    return matched[1].trim();
  }
  return trimmed;
}

function renderChangedFilesCell(changedFiles: string[]): string {
  return normalizeChangedFiles(changedFiles)
    .map((file) => `\`${escapeInlineCode(file)}\``)
    .join("<br>");
}

function renderValidationCell(): string {
  return "See `## テスト` section.";
}

function renderBulletList(values: string[]): string[] {
  return values.map((value) => `- ${normalizeBodyText(value)}`);
}

export function renderCanonicalPrBody(input: CanonicalPrBodyInput): string {
  const summary = normalizeBodyText(
    stripTaskPrefix(input.summary || input.title || input.expectedTaskIssue.taskId)
  );
  const acceptanceCriteria = normalizeStringArray(input.acceptanceCriteria, sanitizeTableCellText);
  const changedFiles = normalizeChangedFiles(input.changedFiles);
  const changeSummaryBullets = normalizeStringArray(input.changeSummaryBullets, normalizeBodyText);
  const commitUnits = normalizeStringArray(
    input.expectedTaskIssue.commitUnits ?? [],
    normalizeBodyText
  );
  const tests = normalizeStringArray(input.tests, normalizeBodyText);
  const effectiveSummary = summary || input.expectedTaskIssue.taskId;
  const effectiveCriteria = acceptanceCriteria.length > 0 ? acceptanceCriteria : [effectiveSummary];
  const effectiveChangeSummary =
    changeSummaryBullets.length > 0 ? changeSummaryBullets : [effectiveSummary];

  if (changedFiles.length === 0) {
    throw new Error("canonical PR body requires at least one changed file");
  }
  if (tests.length === 0) {
    throw new Error("canonical PR body requires at least one validation command");
  }

  const lines: string[] = [
    "## 概要",
    effectiveSummary,
    "",
    "## Linked Task Issue (必須)",
    `- Closes #${input.expectedTaskIssue.issueNumber}`,
    "",
    "## 変更内容",
    ...renderBulletList(effectiveChangeSummary),
    "",
    "## Acceptance Criteria Coverage (必須)",
    "| Acceptance Criteria (issue) | Changed Files | Validation (checks/tests) |",
    "| --- | --- | --- |",
    ...effectiveCriteria.map(
      (criterion) =>
        `| ${criterion} | ${renderChangedFilesCell(changedFiles)} | ${renderValidationCell()} |`
    ),
    "",
    "## Commit Unit Coverage (必須)",
    ...(commitUnits.length > 0
      ? commitUnits.map((commitUnit) => `- \`${escapeInlineCode(commitUnit)}\``)
      : ["- `_No response_`"]),
    "",
    "## テスト",
    ...tests.map((command) => `- \`${escapeInlineCode(command)}\``),
    "",
    "## Evaluation-first Checklist (必須)",
    "- [x] 対応Issueの Acceptance Criteria を全件マッピングした",
    "- [x] 変更ファイルは `Allowed Files` の範囲内に収まっている",
    "- [x] 全ての non-merge commit が宣言済み `CU<n>` にちょうど 1 つ紐づいている",
    "- [x] 実行した検証コマンドを `Acceptance Checks` / `Tests` から記載した",
    "- [x] マッピングできない要件がある場合、実装前に Issue を更新した",
  ];

  return `${lines.join("\n")}\n`;
}

function shortSha(value: string): string {
  return value.trim().slice(0, 7) || "(unknown)";
}

function normalizeActorLogin(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function isDependencyBotManagedPullRequest(headRef: string, authorLogin: string): boolean {
  const normalizedHeadRef = String(headRef || "")
    .trim()
    .toLowerCase();
  const normalizedAuthor = normalizeActorLogin(authorLogin);
  return (
    normalizedHeadRef.startsWith("dependabot/") ||
    normalizedHeadRef.startsWith("renovate/") ||
    normalizedAuthor === "dependabot[bot]" ||
    normalizedAuthor === "app/dependabot" ||
    normalizedAuthor === "renovate[bot]" ||
    normalizedAuthor === "app/renovate"
  );
}

export function classifyPrBodyTraceabilityMode(options: {
  headRef?: string;
  authorLogin?: string;
  expectedTaskIssue?: ExpectedTaskIssue | null;
}): PrBodyTraceabilityMode {
  if (options.expectedTaskIssue) {
    return "canonical-task-pr";
  }

  const headRef = String(options.headRef || "").trim();
  if (extractTaskIdFromBranch(headRef)) {
    return "canonical-task-pr";
  }

  if (isDependencyBotManagedPullRequest(headRef, String(options.authorLogin || ""))) {
    return "dependency-bot-managed-pr";
  }

  return "unsupported-non-task-pr";
}

function commitSubject(message: string): string {
  const line = String(message || "").split(/\r?\n/, 1)[0];
  return String(line || "").trim();
}

function runCommand(cmd: string[], options: { maxBuffer?: number } = {}): string {
  return execFileSync(cmd[0], cmd.slice(1), {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: options.maxBuffer,
  }).trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildIssueReferenceCandidates(expectedTaskIssue: ExpectedTaskIssue): string[] {
  const refs = new Set<string>();
  refs.add(`#${expectedTaskIssue.issueNumber}`);

  const issueUrl = String(expectedTaskIssue.issueUrl || "")
    .trim()
    .replace(/\/+$/, "");
  if (issueUrl) {
    refs.add(issueUrl);

    const matched = issueUrl.match(/^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/issues\/\d+$/i);
    if (matched?.[1]) {
      refs.add(`${matched[1]}#${expectedTaskIssue.issueNumber}`);
    }
  }

  return [...refs];
}

function extractClosingIssueNumbers(markdown: string, repository: string): number[] {
  const [repoOwner, repoName] = repository.split("/", 2).map((value) => value.trim());
  if (!repoOwner || !repoName) {
    return [];
  }

  const out = new Set<number>();
  const pattern = new RegExp(
    String.raw`\b(?:${CLOSING_KEYWORD_PATTERN})\b\s*:?\s*(?:https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)|([^/\s#]+)\/([^/\s#]+)#(\d+)|#(\d+))`,
    "gi"
  );

  for (const match of markdown.matchAll(pattern)) {
    const issueOwner = String(match[1] || match[4] || repoOwner).trim();
    const issueRepo = String(match[2] || match[5] || repoName).trim();
    if (issueOwner !== repoOwner || issueRepo !== repoName) {
      continue;
    }

    const issueNumber = Number(match[3] || match[6] || match[7] || 0);
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) continue;
    out.add(issueNumber);
  }

  return [...out];
}

export function containsClosingKeywordForIssue(
  markdown: string,
  expectedTaskIssue: ExpectedTaskIssue
): boolean {
  const body = markdown.replace(/\r/g, "");
  const refs = buildIssueReferenceCandidates(expectedTaskIssue);
  return refs.some((ref) =>
    new RegExp(
      `\\b(?:${CLOSING_KEYWORD_PATTERN})\\b\\s*:?\\s*${escapeRegex(ref)}(?=$|\\s|[)\\].,;!?])`,
      "i"
    ).test(body)
  );
}

function parseTaskIssueTraceabilityContract(
  issueNumber: number,
  title: string,
  body: string
): { metadata: TaskIssueCandidate["metadata"]; taskId: string } {
  const metadata = parseTaskMetadata({
    issueNumber,
    title,
    state: "open",
    labels: ["task"],
    source: normalizeSourceIssue({
      number: issueNumber,
      title,
      state: "open",
      body,
    }),
  });

  return {
    taskId: normalizeTaskId(
      metadata.task_id ||
        extractTaskIdFromIssueBody(body) ||
        extractTaskIdFromIssueTitle(title) ||
        ""
    ),
    metadata: {
      admission_mode: metadata.admission_mode,
      global_invariant: metadata.global_invariant,
      unfreeze_condition: metadata.unfreeze_condition,
      allowed_files: metadata.allowed_files,
      commit_units: metadata.commit_units,
      reviewer_outcomes: metadata.reviewer_outcomes,
      canonical_gap: metadata.canonical_gap,
      canonical_gap_owner: metadata.canonical_gap_owner,
      canonical_gap_review_date: metadata.canonical_gap_review_date,
      canonical_deferral_reason: metadata.canonical_deferral_reason,
      canonical_deferral_condition: metadata.canonical_deferral_condition,
      task_sizing_exception: metadata.task_sizing_exception,
      task_sizing_exception_type: metadata.task_sizing_exception_type,
      task_sizing_split_failure: metadata.task_sizing_split_failure,
      task_sizing_exception_reviewer_attestation:
        metadata.task_sizing_exception_reviewer_attestation,
      task_sizing_unsafe_state: metadata.task_sizing_unsafe_state,
      task_sizing_affected_invariant: metadata.task_sizing_affected_invariant,
      task_sizing_atomic_boundary: metadata.task_sizing_atomic_boundary,
    },
  };
}

function buildTaskIssueCandidate(
  repository: string,
  issueNumber: number,
  title: string,
  body: string,
  url: string
): TaskIssueCandidate {
  const contract = parseTaskIssueTraceabilityContract(issueNumber, title, body);
  return {
    number: issueNumber,
    body,
    taskId: contract.taskId,
    url: url.trim() || `https://github.com/${repository}/issues/${issueNumber}`,
    metadata: contract.metadata,
  };
}

function normalizePullRequestState(state: unknown, mergedAt?: unknown): string {
  const normalized = String(state ?? "")
    .trim()
    .toUpperCase();
  if (normalized) {
    return normalized;
  }
  return String(mergedAt ?? "").trim() ? "MERGED" : "OPEN";
}

function isClosedPullRequestState(state: string): boolean {
  const normalized = normalizePullRequestState(state);
  return normalized === "CLOSED" || normalized === "MERGED";
}

function fetchPullRequestChangedFiles(repository: string, pullNumber: number): string[] {
  const output = runCommand([
    "gh",
    "api",
    "--paginate",
    `repos/${repository}/pulls/${pullNumber}/files`,
    "--jq",
    ".[].filename",
  ]);
  const paths = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return normalizeChangedFiles(paths);
}

function fetchPullRequestCommits(repository: string, pullNumber: number): PullRequestCommit[] {
  const output = runCommand(
    [
      "gh",
      "api",
      "--paginate",
      `repos/${repository}/pulls/${pullNumber}/commits`,
      "--jq",
      ".[] | @base64",
    ],
    { maxBuffer: GH_PR_COMMITS_MAX_BUFFER_BYTES }
  );
  if (!output) return [];

  const commits: PullRequestCommit[] = [];
  for (const line of output.split(/\r?\n/)) {
    const encoded = line.trim();
    if (!encoded) continue;
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const parsed = JSON.parse(decoded) as {
      sha?: unknown;
      parents?: unknown[];
      commit?: { message?: unknown } | null;
    };
    const sha = String(parsed.sha || "").trim();
    const message = String(parsed.commit?.message || "");
    const parentCount = Array.isArray(parsed.parents) ? parsed.parents.length : 0;
    if (!sha || !message) continue;
    commits.push({ sha, message, parentCount });
  }

  return commits;
}

function fetchOpenTaskIssues(repository: string): TaskIssueCandidate[] {
  const out: TaskIssueCandidate[] = [];
  let page = 1;

  for (;;) {
    const output = runCommand(
      ["gh", "api", `repos/${repository}/issues?labels=task&state=open&per_page=100&page=${page}`],
      { maxBuffer: GH_ISSUE_LIST_MAX_BUFFER_BYTES }
    );
    const parsed = JSON.parse(output || "[]") as Array<Record<string, unknown>>;
    if (!Array.isArray(parsed) || parsed.length === 0) {
      break;
    }

    for (const raw of parsed) {
      if (raw.pull_request) continue;
      const number = Number(raw.number || 0);
      if (!Number.isInteger(number) || number <= 0) continue;
      const title = String(raw.title || "");
      const body = String(raw.body || "");

      out.push(
        buildTaskIssueCandidate(repository, number, title, body, String(raw.html_url || "").trim())
      );
    }

    if (parsed.length < 100) {
      break;
    }
    page += 1;
  }

  return out;
}

function loadOpenTaskIssuesFromSource(
  repository: string,
  sourcePath: string
): TaskIssueCandidate[] {
  if (!existsSync(sourcePath)) {
    fail(`offline issue source not found: ${sourcePath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(sourcePath, "utf8"));
  } catch (error) {
    fail(
      `failed to parse offline issue source ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (!Array.isArray(parsed)) {
    fail(`offline issue source must be a JSON array: ${sourcePath}`);
  }

  const out: TaskIssueCandidate[] = [];
  for (const entry of parsed) {
    const normalized = normalizeSourceIssue((entry || {}) as GraphIssueNode);
    const state = parseIssueState(normalized.state);
    if (state !== "open") continue;
    out.push(
      buildTaskIssueCandidate(
        repository,
        normalized.number,
        String(normalized.title || ""),
        normalized.body,
        String(normalized.html_url || "")
      )
    );
  }

  return out;
}

function fetchTaskIssuesByNumber(repository: string, issueNumbers: number[]): TaskIssueCandidate[] {
  const out: TaskIssueCandidate[] = [];

  for (const issueNumber of [...new Set(issueNumbers)].sort((left, right) => left - right)) {
    const output = runCommand(["gh", "api", `repos/${repository}/issues/${issueNumber}`]);
    const parsed = JSON.parse(output || "{}") as {
      number?: unknown;
      body?: unknown;
      html_url?: unknown;
      pull_request?: unknown;
      labels?: Array<{ name?: unknown }> | null;
    };
    if (parsed.pull_request) {
      continue;
    }

    const labelNames = new Set(
      (parsed.labels ?? [])
        .map((label) =>
          String(label?.name ?? "")
            .trim()
            .toLowerCase()
        )
        .filter(Boolean)
    );
    if (!labelNames.has("task")) {
      continue;
    }

    const number = Number(parsed.number ?? issueNumber);
    if (!Number.isInteger(number) || number <= 0) continue;
    out.push(
      buildTaskIssueCandidate(
        repository,
        number,
        String((parsed as { title?: unknown }).title ?? ""),
        String(parsed.body ?? ""),
        String(parsed.html_url ?? "")
      )
    );
  }

  return out;
}

export function extractDeclaredCommitUnitIds(values: string[]): {
  ids: string[];
  errors: string[];
} {
  const ids: string[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const text = String(value || "").trim();
    if (!text) continue;
    const match = text.match(DECLARED_COMMIT_UNIT_PATTERN);
    if (!match?.[1]) {
      errors.push(`Canonical task issue Commit Unit entry is missing CU<n>: ${text}`);
      continue;
    }
    const id = match[1].toUpperCase();
    if (seen.has(id)) {
      errors.push(`Canonical task issue declares duplicate Commit Unit: ${id}`);
      continue;
    }
    seen.add(id);
    ids.push(id);
  }

  return { ids, errors };
}

export function extractCommitUnitRefsFromMessage(message: string): string[] {
  const refs = new Set<string>();

  const subjectMatch = commitSubject(message).match(COMMIT_UNIT_SUBJECT_PATTERN);
  if (subjectMatch?.[1]) {
    refs.add(subjectMatch[1].toUpperCase());
  }

  for (const match of message.matchAll(new RegExp(COMMIT_UNIT_TRAILER_SOURCE, "gim"))) {
    if (!match[1]) continue;
    refs.add(match[1].toUpperCase());
  }

  return [...refs];
}

export function validateAllowedFilesBoundary(
  changedFiles: string[],
  allowedFiles: string[] | undefined
): string[] {
  if (!allowedFiles) return [];

  const normalizedAllowedFiles = normalizeChangedFiles(allowedFiles);
  if (normalizedAllowedFiles.length === 0) {
    return ["Canonical task issue is missing Allowed Files; normalize the issue before merge."];
  }

  const errors: string[] = [];
  for (const file of normalizeChangedFiles(changedFiles)) {
    const withinBoundary = normalizedAllowedFiles.some((pattern) =>
      overlapsPathPattern(file, pattern)
    );
    if (withinBoundary) continue;
    errors.push(
      `PR changed file escapes Allowed Files: ${file} (no declared pattern matched the actual diff path)`
    );
  }

  return errors;
}

export function validateCommitUnitCoverage(
  commits: PullRequestCommit[],
  declaredCommitUnits: string[] | undefined
): string[] {
  if (!declaredCommitUnits) return [];

  const findings = collectCommitUnitTraceabilityFindings(commits, declaredCommitUnits);
  const errors = [...findings.errors];
  if (findings.declarationIds.length === 0) {
    return errors;
  }
  if (!findings.hasNonMergeCommits) {
    errors.push(
      "No non-merge commits were resolved from the pull request; cannot prove Commit Unit coverage."
    );
    return errors;
  }
  for (const commitUnitId of findings.declarationIds) {
    if (findings.coveredIds.has(commitUnitId)) continue;
    errors.push(`Declared Commit Unit has no corresponding PR commit: ${commitUnitId}`);
  }

  return errors;
}

type CommitUnitTraceabilityFindings = {
  coveredIds: Set<string>;
  declarationIds: string[];
  errors: string[];
  hasNonMergeCommits: boolean;
};

function collectCommitUnitTraceabilityFindings(
  commits: PullRequestCommit[],
  declaredCommitUnits: string[]
): CommitUnitTraceabilityFindings {
  const errors: string[] = [];
  const mergeCommits = commits.filter((commit) => commit.parentCount > 1);
  if (mergeCommits.length > 0) {
    errors.push(
      `Task pull requests must keep linear history; merge commits are prohibited: ${mergeCommits.map((commit) => shortSha(commit.sha)).join(", ")}`
    );
  }

  const declarations = extractDeclaredCommitUnitIds(declaredCommitUnits);
  errors.push(...declarations.errors);
  if (declarations.ids.length === 0) {
    errors.push("Canonical task issue is missing Commit Units; normalize the issue before merge.");
    return {
      coveredIds: new Set<string>(),
      declarationIds: [],
      errors,
      hasNonMergeCommits: commits.some((commit) => commit.parentCount <= 1),
    };
  }

  const nonMergeCommits = commits.filter((commit) => commit.parentCount <= 1);
  const declaredIds = new Set(declarations.ids);
  const coveredIds = new Set<string>();

  for (const commit of nonMergeCommits) {
    const subject = commitSubject(commit.message) || "(no subject)";
    const refs = extractCommitUnitRefsFromMessage(commit.message);
    if (refs.length !== 1) {
      errors.push(
        `PR commit ${shortSha(commit.sha)} (${subject}) must reference exactly one declared Commit Unit via subject prefix "CU<n>:" or trailer "CU: CU<n>"`
      );
      continue;
    }

    const commitUnitId = refs[0];
    if (!declaredIds.has(commitUnitId)) {
      errors.push(
        `PR commit ${shortSha(commit.sha)} (${subject}) references undeclared Commit Unit ${commitUnitId}; declared units: ${declarations.ids.join(", ")}`
      );
      continue;
    }

    coveredIds.add(commitUnitId);
  }

  return {
    coveredIds,
    declarationIds: declarations.ids,
    errors,
    hasNonMergeCommits: nonMergeCommits.length > 0,
  };
}

export function validateCommitTraceability(
  message: string,
  options: CommitTraceabilityOptions
): string[] {
  return collectCommitUnitTraceabilityFindings(
    [
      {
        sha: "LOCAL",
        message,
        parentCount: 1,
      },
    ],
    options.expectedTaskIssue.commitUnits
  ).errors;
}

export function validateTaskIssueSizingContract(expectedTaskIssue: ExpectedTaskIssue): string[] {
  const findings = collectTaskSizingFindings({
    issueNumber: expectedTaskIssue.issueNumber,
    taskId: expectedTaskIssue.taskId,
    admissionMode: expectedTaskIssue.admissionMode,
    globalInvariant: expectedTaskIssue.globalInvariant,
    unfreezeCondition: expectedTaskIssue.unfreezeCondition,
    allowedFiles: expectedTaskIssue.allowedFiles ?? [],
    commitUnits: expectedTaskIssue.commitUnits ?? [],
    reviewerOutcomes: expectedTaskIssue.reviewerOutcomes ?? [],
    canonicalGap: expectedTaskIssue.canonicalGap,
    canonicalGapOwner: expectedTaskIssue.canonicalGapOwner,
    canonicalGapReviewDate: expectedTaskIssue.canonicalGapReviewDate,
    canonicalDeferralReason: expectedTaskIssue.canonicalDeferralReason,
    canonicalDeferralCondition: expectedTaskIssue.canonicalDeferralCondition,
    taskSizingException: expectedTaskIssue.taskSizingException,
    taskSizingExceptionType: expectedTaskIssue.taskSizingExceptionType,
    taskSizingSplitFailure: expectedTaskIssue.taskSizingSplitFailure,
    taskSizingExceptionReviewerAttestation:
      expectedTaskIssue.taskSizingExceptionReviewerAttestation,
    taskSizingUnsafeState: expectedTaskIssue.taskSizingUnsafeState,
    taskSizingAffectedInvariant: expectedTaskIssue.taskSizingAffectedInvariant,
    taskSizingAtomicBoundary: expectedTaskIssue.taskSizingAtomicBoundary,
  });

  return findings.errors.map(
    (error) =>
      `Canonical task issue violates task sizing contract; normalize the issue before merge. ${error}`
  );
}

function resolveEventContext(eventPath: string): EventContext {
  if (!eventPath) {
    fail("missing PR body source; pass --body/--body-file/--event-path or set GITHUB_EVENT_PATH");
  }
  if (!existsSync(eventPath)) {
    fail(`event payload file not found: ${eventPath}`);
  }

  const raw = readFileSync(eventPath, "utf8");
  const payload = JSON.parse(raw) as {
    pull_request?: {
      body?: string | null;
      number?: number | null;
      head?: { ref?: string | null };
      user?: { login?: string | null };
      state?: string | null;
      merged_at?: string | null;
    };
    number?: number | null;
    repository?: { full_name?: string | null };
  };

  const body = payload.pull_request?.body;
  if (typeof body !== "string") {
    fail("pull_request.body was not found in event payload");
  }

  const repository = String(payload.repository?.full_name ?? "").trim();
  if (!repository || !repository.includes("/")) {
    fail("repository.full_name was not found in event payload");
  }

  const pullNumber = Number(payload.pull_request?.number ?? payload.number ?? 0);
  if (!Number.isInteger(pullNumber) || pullNumber <= 0) {
    fail("pull_request.number was not found in event payload");
  }

  const headRef = String(payload.pull_request?.head?.ref ?? "").trim();
  if (!headRef) {
    fail("pull_request.head.ref was not found in event payload");
  }

  const authorLogin = String(payload.pull_request?.user?.login ?? "").trim();

  return {
    body,
    repository,
    pullNumber,
    headRef,
    authorLogin,
    pullRequestState: normalizePullRequestState(
      payload.pull_request?.state,
      payload.pull_request?.merged_at
    ),
    closingIssueNumbers: extractClosingIssueNumbers(body, repository),
  };
}

function fetchPullRequestContext(repository: string, pullNumber: number): EventContext {
  const output = runCommand(["gh", "api", `repos/${repository}/pulls/${pullNumber}`]);
  const payload = JSON.parse(output) as {
    body?: unknown;
    head?: { ref?: unknown } | null;
    user?: { login?: unknown } | null;
    state?: unknown;
    merged_at?: unknown;
  };

  const body = String(payload.body ?? "");

  const headRef = String(payload.head?.ref ?? "").trim();
  if (!headRef) {
    fail(`pull request #${pullNumber} head ref was not found via GitHub API`);
  }

  const authorLogin = String(payload.user?.login ?? "").trim();

  return {
    body,
    repository,
    pullNumber,
    headRef,
    authorLogin,
    pullRequestState: normalizePullRequestState(payload.state, payload.merged_at),
    closingIssueNumbers: extractClosingIssueNumbers(body, repository),
  };
}

export function resolveExpectedTaskIssueFromTaskIssues(
  headRef: string,
  _repository: string,
  issues: TaskIssueCandidate[],
  options: ResolveExpectedTaskIssueOptions = {}
): ExpectedTaskIssue | null {
  const taskId = extractTaskIdFromBranch(headRef);
  if (!taskId) return null;

  const normalizedTaskId = normalizeTaskId(taskId);
  const matched = issues.filter((issue) => issue.taskId === normalizedTaskId);

  if (matched.length > 1) {
    throw new Error(
      `multiple open GitHub task issues found for ${normalizedTaskId}: ${matched.map((issue) => `#${issue.number}`).join(", ")}`
    );
  }

  const closedLinkedIssues = (options.closedLinkedIssues ?? []).filter(
    (issue) => issue.taskId === normalizedTaskId
  );
  if (closedLinkedIssues.length > 1) {
    throw new Error(
      `multiple closed PR-linked task issues found for ${normalizedTaskId}: ${closedLinkedIssues.map((issue) => `#${issue.number}`).join(", ")}`
    );
  }

  const issue = matched[0] ?? closedLinkedIssues[0];
  if (!issue) {
    throw new Error(
      `no open GitHub task issue found for ${normalizedTaskId}. Create or normalize the canonical task issue before implementation.`
    );
  }
  return {
    taskId: normalizedTaskId,
    issueNumber: issue.number,
    issueUrl: issue.url,
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
    taskSizingException: issue.metadata.task_sizing_exception,
    taskSizingExceptionType: issue.metadata.task_sizing_exception_type,
    taskSizingSplitFailure: issue.metadata.task_sizing_split_failure,
    taskSizingExceptionReviewerAttestation:
      issue.metadata.task_sizing_exception_reviewer_attestation,
    taskSizingUnsafeState: issue.metadata.task_sizing_unsafe_state,
    taskSizingAffectedInvariant: issue.metadata.task_sizing_affected_invariant,
    taskSizingAtomicBoundary: issue.metadata.task_sizing_atomic_boundary,
  };
}

async function resolveExpectedTaskIssueFromContext(
  context: EventContext
): Promise<ExpectedTaskIssue | null> {
  await Promise.resolve();
  const closedLinkedIssues = isClosedPullRequestState(context.pullRequestState)
    ? fetchTaskIssuesByNumber(context.repository, context.closingIssueNumbers)
    : [];
  return resolveExpectedTaskIssueFromTaskIssues(
    context.headRef,
    context.repository,
    fetchOpenTaskIssues(context.repository),
    { closedLinkedIssues }
  );
}

export function validatePrBodyTraceability(
  markdown: string,
  options: PrBodyTraceabilityOptions = {}
): string[] {
  const body = markdown.trim();
  const errors: string[] = [];
  const mappedChangedFiles = new Set<string>();
  const actualChangedFiles = normalizeChangedFiles(options.changedFiles ?? []);
  const actualCommits = options.commits ?? [];

  if (!body) {
    return ["PR body is empty"];
  }

  const forbiddenRationaleLabels = findForbiddenDesignDeferralLabels(body);
  if (forbiddenRationaleLabels.length > 0) {
    errors.push(
      `PR body must not justify a known non-canonical design with forbidden rationale (${[
        ...new Set(forbiddenRationaleLabels),
      ].join(", ")})`
    );
  }

  const rows = findCoverageTableRows(body);
  if (!rows) {
    errors.push(
      "Acceptance Criteria coverage table is missing (required headers: Acceptance Criteria (issue) | Changed Files | Validation (checks/tests))"
    );
  } else {
    const dataRows = rows
      .slice(2)
      .filter((row) => row.length === REQUIRED_TABLE_HEADERS.length)
      .map((row) => row.map((cell) => cell.trim()));

    const completeRows = dataRows.filter((row) => row.every((cell) => !isPlaceholderCell(cell)));
    if (completeRows.length === 0) {
      errors.push(
        "Acceptance Criteria coverage table must include at least one non-placeholder mapping row"
      );
    }

    for (const row of completeRows) {
      const changedFiles = parseChangedFilesCell(row[1] ?? "");
      if (changedFiles.length === 0) {
        errors.push(
          `Acceptance Criteria coverage table row has no parsable changed file path in backticks: ${row[0] ?? "(unknown criteria)"}`
        );
        continue;
      }
      for (const file of changedFiles) {
        mappedChangedFiles.add(file);
      }
    }
  }

  if (actualChangedFiles.length > 0) {
    const expectedSet = new Set<string>(actualChangedFiles);

    const mappedOnly = [...mappedChangedFiles].filter((file) => !expectedSet.has(file)).sort();
    for (const file of mappedOnly) {
      errors.push(`Coverage table lists changed file not present in PR diff: ${file}`);
    }

    const unmapped = actualChangedFiles.filter((file) => !mappedChangedFiles.has(file));
    for (const file of unmapped) {
      errors.push(`PR changed file is not mapped in coverage table: ${file}`);
    }
  }

  const checklistItems = collectChecklistItems(body);
  for (const required of REQUIRED_CHECKLIST_ITEMS) {
    const normalizedRequired = normalizeChecklistText(required);
    const found = checklistItems.find((item) => item.text.includes(normalizedRequired));
    if (!found) {
      errors.push(`Evaluation-first checklist item is missing: ${required}`);
      continue;
    }
    if (!found.checked) {
      errors.push(`Evaluation-first checklist item must be checked: ${required}`);
    }
  }

  const expectedTaskIssue = options.expectedTaskIssue ?? null;
  if (expectedTaskIssue && !containsClosingKeywordForIssue(body, expectedTaskIssue)) {
    errors.push(
      `PR body must close canonical task issue #${expectedTaskIssue.issueNumber} (${expectedTaskIssue.taskId}) with a closing keyword such as 'Closes #${expectedTaskIssue.issueNumber}'`
    );
  }

  if (expectedTaskIssue && actualChangedFiles.length > 0) {
    errors.push(
      ...validateAllowedFilesBoundary(actualChangedFiles, expectedTaskIssue.allowedFiles)
    );
  }

  if (expectedTaskIssue && actualCommits.length > 0) {
    errors.push(...validateCommitUnitCoverage(actualCommits, expectedTaskIssue.commitUnits));
  }

  if (expectedTaskIssue) {
    errors.push(...validateTaskIssueSizingContract(expectedTaskIssue));
  }

  return errors;
}

function parseChangedFilesFromFile(path: string): string[] {
  if (!existsSync(path)) {
    fail(`changed files file not found: ${path}`);
  }
  const raw = readFileSync(path, "utf8");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function parseArgs(argv: string[]): {
  body: string;
  commitMessageFile: string;
  eventPath: string;
  jsonOutput: boolean;
  changedFiles: string[];
  repository: string;
  pullNumber: number;
  sourcePath: string;
} {
  const program = new Command()
    .name("check-pr-body-traceability")
    .description(
      "Validate task-contract traceability from commit messages, PR body, actual diff, actual commits, and canonical task issue fields"
    )
    .option(
      "--commit-message-file <path>",
      "Validate a local commit message before commit completes"
    )
    .option("--body <text>", "Validate explicit PR body text")
    .option("--body-file <path>", "Validate PR body loaded from file")
    .option("--event-path <path>", "Validate pull_request.body from a GitHub event payload JSON")
    .option("--repository <owner/repo>", "Fetch PR context from the GitHub API for this repository")
    .option("--pull-number <number>", "Fetch PR context from the GitHub API for this pull request")
    .option("--source <path>", "Offline issue JSON source for canonical task issue resolution")
    .option(
      "--changed-file <path...>",
      "Add changed file paths for coverage validation (repeatable)"
    )
    .option("--changed-files-file <path>", "Add changed file paths from line-separated file")
    .option("--json", "Output validation result as JSON", false)
    .parse(["node", "check-pr-body-traceability", ...argv]);

  const opts = program.opts<{
    commitMessageFile?: string;
    body?: string;
    bodyFile?: string;
    eventPath?: string;
    repository?: string;
    pullNumber?: string;
    source?: string;
    changedFile?: string[];
    changedFilesFile?: string;
    json: boolean;
  }>();

  const changedFiles: string[] = [...(opts.changedFile || [])];
  if (opts.changedFilesFile) {
    changedFiles.push(...parseChangedFilesFromFile(opts.changedFilesFile));
  }

  if (opts.commitMessageFile) {
    if (!existsSync(opts.commitMessageFile)) {
      fail(`commit message file not found: ${opts.commitMessageFile}`);
    }
    return {
      body: "",
      commitMessageFile: opts.commitMessageFile,
      eventPath: "",
      jsonOutput: opts.json,
      changedFiles,
      repository: "",
      pullNumber: 0,
      sourcePath: String(opts.source || "").trim(),
    };
  }

  if (opts.body) {
    return {
      body: opts.body,
      commitMessageFile: "",
      eventPath: "",
      jsonOutput: opts.json,
      changedFiles,
      repository: "",
      pullNumber: 0,
      sourcePath: String(opts.source || "").trim(),
    };
  }

  if (opts.bodyFile) {
    if (!existsSync(opts.bodyFile)) {
      fail(`body file not found: ${opts.bodyFile}`);
    }
    return {
      body: readFileSync(opts.bodyFile, "utf8"),
      commitMessageFile: "",
      eventPath: "",
      jsonOutput: opts.json,
      changedFiles,
      repository: "",
      pullNumber: 0,
      sourcePath: String(opts.source || "").trim(),
    };
  }

  const repository = String(opts.repository || "").trim();
  const pullNumber = Number(opts.pullNumber || 0);
  const explicitEventPath = String(opts.eventPath || "").trim();
  const hasPullRequestApiContext =
    repository.length > 0 && Number.isInteger(pullNumber) && pullNumber > 0;

  return {
    body: "",
    commitMessageFile: "",
    eventPath:
      explicitEventPath ||
      (hasPullRequestApiContext ? "" : Bun.env.GITHUB_EVENT_PATH?.trim() || ""),
    jsonOutput: opts.json,
    changedFiles,
    repository,
    pullNumber,
    sourcePath: String(opts.source || "").trim(),
  };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));

  let body = parsed.body;
  const commitMessageFile = parsed.commitMessageFile;
  let changedFiles = parsed.changedFiles;
  let commits: PullRequestCommit[] = [];
  let expectedTaskIssue: ExpectedTaskIssue | null = null;
  let traceabilityMode: PrBodyTraceabilityMode = "canonical-task-pr";
  let commitTraceabilityErrors: string[] | null = null;

  if (commitMessageFile) {
    const repoRoot = runCommand(["git", "rev-parse", "--show-toplevel"]);
    const branch = currentGitBranch(repoRoot);
    const repository = detectRepositoryFromOrigin(repoRoot);
    const sourcePath =
      parsed.sourcePath ||
      String(Bun.env.OMTA_TASK_ISSUE_SOURCE || "").trim() ||
      String(Bun.env.ISSUE_GRAPH_SOURCE || "").trim();
    const issues = sourcePath
      ? loadOpenTaskIssuesFromSource(repository, sourcePath)
      : fetchOpenTaskIssues(repository);
    expectedTaskIssue = resolveExpectedTaskIssueFromTaskIssues(branch, repository, issues);
    if (!expectedTaskIssue) {
      fail(
        "commit traceability requires a canonical task/<TASK_ID>-<slug> branch and task issue before implementation"
      );
    }
    commitTraceabilityErrors = validateCommitTraceability(readFileSync(commitMessageFile, "utf8"), {
      expectedTaskIssue,
    });
  }

  if (!body && !commitMessageFile) {
    let context: EventContext;
    if (parsed.eventPath) {
      context = resolveEventContext(parsed.eventPath);
    } else if (parsed.repository && Number.isInteger(parsed.pullNumber) && parsed.pullNumber > 0) {
      context = fetchPullRequestContext(parsed.repository, parsed.pullNumber);
    } else {
      context = fail(
        "missing PR body source; pass --body/--body-file/--event-path or --repository with --pull-number"
      );
    }
    body = context.body;
    if (changedFiles.length === 0) {
      changedFiles = fetchPullRequestChangedFiles(context.repository, context.pullNumber);
    }
    if (changedFiles.length === 0) {
      fail("no changed files were resolved from pull request diff");
    }
    commits = fetchPullRequestCommits(context.repository, context.pullNumber);
    if (commits.length === 0) {
      fail("no commits were resolved from pull request");
    }
    expectedTaskIssue = await resolveExpectedTaskIssueFromContext(context);
    traceabilityMode = classifyPrBodyTraceabilityMode({
      headRef: context.headRef,
      authorLogin: context.authorLogin,
      expectedTaskIssue,
    });
  }

  let errors: string[];
  if (commitTraceabilityErrors) {
    errors = commitTraceabilityErrors;
  } else if (traceabilityMode === "dependency-bot-managed-pr") {
    errors = [];
  } else if (traceabilityMode === "unsupported-non-task-pr") {
    errors = [
      "non-task pull requests must use canonical task/<task-id>-<slug> branches; only canonical dependency-bot PRs may bypass the task PR body contract",
    ];
  } else {
    errors = validatePrBodyTraceability(body, {
      changedFiles,
      commits,
      expectedTaskIssue,
    });
  }

  if (parsed.jsonOutput) {
    process.stdout.write(
      `${JSON.stringify({ ok: errors.length === 0, error_count: errors.length, errors }, null, 2)}\n`
    );
  }

  if (errors.length > 0) {
    if (!parsed.jsonOutput) {
      process.stderr.write("check:pr-body-traceability failed:\n");
      for (const error of errors) {
        process.stderr.write(`- ${error}\n`);
      }
    }
    process.exit(1);
  }

  if (!parsed.jsonOutput) {
    process.stdout.write("check:pr-body-traceability passed\n");
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`check:pr-body-traceability failed: ${(error as Error).message}\n`);
    process.exit(1);
  }
}
