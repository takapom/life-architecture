#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

type JsonObject = Record<string, unknown>;

type UpsertAction = "created" | "updated" | "create_planned" | "update_planned";
type SubIssueLinkState = "not_requested" | "link_planned" | "linked" | "already_linked";
type IssueReference = { issueNumber: number; repository: string };

type UpsertTargetIssue = {
  number: number;
  url: string;
};

type UpsertResult = {
  action: UpsertAction;
  repository: string;
  task_id: string;
  issue_number: number;
  issue_url: string;
  title: string;
  parent_issue_number?: number;
  sub_issue_link_state?: SubIssueLinkState;
};

type UpsertItem = {
  issue: IssuePayload;
  issueNumber: number;
  taskIdHint: string;
  parentIssueNumber: number;
};

type RemoteTaskIssue = {
  number: number;
  title: string;
  body: string;
  url: string;
  labels?: string[];
  state?: string;
};

export type IssuePayload = {
  title: string;
  body: string;
  labels: string[];
};

const TASK_ID_VALUE_SOURCE = "[A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*-\\d{3,}[a-z]?";
const TASK_ID_PATTERN = new RegExp(`^${TASK_ID_VALUE_SOURCE}$`);
const TASK_ID_HINT_PATTERN = new RegExp(
  `(?:^|\\n)\\s*(?:[-*+]\\s*)?Task\\s*ID\\s*(?:[:\\-]\\s*|\\n+\\s*)(?:\\x60)?(${TASK_ID_VALUE_SOURCE})(?:\\x60)?`,
  "im"
);
const TASK_ID_SEARCH_PATTERN = new RegExp(TASK_ID_VALUE_SOURCE, "m");
const TASK_SEARCH_RESULT_LIMIT = 100;
const ISSUE_JSON_FIELDS = "number,title,state,body,url,labels";

function usage(): string {
  return [
    "Usage:",
    "  bun issue_runtime.ts upsert-task-issues --repository <owner/repo> [--parent-issue <number|url>] [--input <path>] [--issue-number <n>] [--create-only] [--dry-run] [--output <path>]",
    "",
    "Notes:",
    "  - --input can be omitted to read JSON from stdin.",
    "  - input payload must be an object with `items` array only.",
    "  - each item must include `task_id` and `issue` fields.",
    "  - parent issue is configured only by --parent-issue (payload parent fields are unsupported).",
    "  - omit --parent-issue for a standalone task issue.",
    "  - --parent-issue is required when upserting multiple task issues in one command.",
    "  - when provided, --parent-issue links each upserted issue as a GitHub Sub-issue of the given parent issue.",
    "  - --create-only fails if task_id already resolves to an open task issue.",
    "  - --repository is required; repository auto-detection is unsupported.",
    "  - upsert commands require GH auth (`GH_TOKEN` or `gh auth login`).",
  ].join("\n");
}

function fail(message: string): never {
  throw new Error(message);
}

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const detail = `${result.stderr || ""}\n${result.stdout || ""}`.trim();
    fail(`${command} ${args.join(" ")} failed: ${detail || `exit=${result.status}`}`);
  }
  return String(result.stdout || "").trim();
}

function runResult(
  command: string,
  args: string[],
  cwd: string
): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: Number(result.status ?? 1),
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
  };
}

function nowIsoUtc(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function ensureString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    fail(`${field} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    fail(`${field} must not be empty`);
  }
  return trimmed;
}

function ensureObject(value: unknown, field: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${field} must be a JSON object`);
  }
  return value as JsonObject;
}

function ensureInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    fail(`${field} must be a positive integer`);
  }
  return parsed;
}

function parseIssueReference(value: unknown, field: string): IssueReference {
  if (value === undefined || value === null || value === "") {
    fail(`${field} is required`);
  }
  if (typeof value === "number") {
    return {
      issueNumber: ensureInteger(value, field),
      repository: "",
    };
  }
  if (typeof value !== "string") {
    fail(`${field} must be an issue number or issue URL`);
  }

  const trimmed = value.trim();
  if (!trimmed) {
    fail(`${field} is required`);
  }
  if (/^\d+$/.test(trimmed)) {
    return {
      issueNumber: ensureInteger(trimmed, field),
      repository: "",
    };
  }
  const matched = trimmed.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/i);
  if (!matched) {
    fail(`${field} must be an issue number or issue URL`);
  }
  return {
    issueNumber: ensureInteger(matched[3], `${field}.issue_number`),
    repository: `${matched[1].toLowerCase()}/${matched[2].toLowerCase()}`,
  };
}

function parseJson(text: string, source: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    fail(`invalid JSON from ${source}: ${(error as Error).message}`);
  }
}

function readTextFile(filePath: string): string {
  const absolute = path.resolve(filePath);
  if (!existsSync(absolute)) {
    fail(`file not found: ${filePath}`);
  }
  return readFileSync(absolute, "utf8");
}

function readJsonFile(filePath: string): unknown {
  return parseJson(readTextFile(filePath), filePath);
}

function readJsonFromInput(inputPath: string): unknown {
  if (inputPath) {
    return readJsonFile(inputPath);
  }
  if (process.stdin.isTTY) {
    fail("missing --input and no stdin payload");
  }
  const stdinText = readFileSync(0, "utf8");
  if (!stdinText.trim()) {
    fail("stdin JSON payload is empty");
  }
  return parseJson(stdinText, "stdin");
}

function writeJsonOutput(payload: unknown, outputPath: string): void {
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  if (outputPath) {
    writeFileSync(path.resolve(outputPath), text, "utf8");
    return;
  }
  process.stdout.write(text);
}

function parseCli(argv: string[]): { command: string; flags: Map<string, string | true> } {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }

  const command = argv[0] ?? "";
  const flags = new Map<string, string | true>();
  const allowedFlags = new Set([
    "input",
    "repository",
    "issue-number",
    "parent-issue",
    "create-only",
    "dry-run",
    "output",
  ]);

  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i] ?? "";
    if (!token.startsWith("--")) {
      fail(`unexpected positional argument: ${token}`);
    }
    const key = token.slice(2);
    if (!key) {
      fail("invalid empty flag");
    }
    if (!allowedFlags.has(key)) {
      fail(`unknown flag: --${key}`);
    }
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      flags.set(key, true);
      continue;
    }
    flags.set(key, next);
    i += 1;
  }

  for (const [key, value] of flags.entries()) {
    if (value === true && key !== "dry-run" && key !== "create-only") {
      fail(`--${key} requires a value`);
    }
  }

  return { command, flags };
}

function getFlag(flags: Map<string, string | true>, key: string): string {
  const value = flags.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function hasBoolFlag(flags: Map<string, string | true>, key: string): boolean {
  return flags.get(key) === true;
}

function mustNotBoolFlag(flags: Map<string, string | true>, key: string): void {
  if (flags.get(key) === true) {
    fail(`--${key} requires a value`);
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function normalizeLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(
    value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean)
  );
}

function normalizeIssuePayload(value: unknown, field: string): IssuePayload {
  const input = ensureObject(value, field);
  const title = ensureString(input.title, `${field}.title`);
  if (typeof input.body !== "string") {
    fail(`${field}.body must be a string`);
  }

  const labels = normalizeLabels(input.labels);
  if (!labels.some((label) => label.toLowerCase() === "task")) {
    labels.push("task");
  }

  return {
    title,
    body: input.body,
    labels: uniqueStrings(labels),
  };
}

export function extractTaskIdFromIssueBody(body: string): string {
  const normalized = body.replace(/\r\n/g, "\n");

  const normalizeCandidate = (raw: string | undefined): string => {
    const text = String(raw || "")
      .trim()
      .replace(/^`([^`]+)`$/, "$1")
      .trim();
    if (!text || text === "_No response_") return "";
    return TASK_ID_PATTERN.test(text) ? text : "";
  };

  const hinted = normalized.match(TASK_ID_HINT_PATTERN);
  const fromHint = normalizeCandidate(hinted?.[1]);
  if (fromHint) return fromHint;

  const fallback = normalized.match(TASK_ID_SEARCH_PATTERN);
  return normalizeCandidate(fallback?.[0]);
}

function extractTaskIdFromTitle(title: string): string {
  const matched = String(title || "").match(TASK_ID_SEARCH_PATTERN);
  if (!matched) return "";
  const taskId = String(matched[0] || "").trim();
  return TASK_ID_PATTERN.test(taskId) ? taskId : "";
}

function extractTaskIdFromLabels(labels: string[] | undefined): string {
  const list = Array.isArray(labels) ? labels : [];
  for (const label of list) {
    const trimmed = String(label || "").trim();
    if (!trimmed.toLowerCase().startsWith("task-id:")) continue;
    const value = trimmed.slice("task-id:".length).trim();
    if (TASK_ID_PATTERN.test(value)) return value;
  }
  return "";
}

function resolveRemoteTaskId(issue: { title?: string; body?: string; labels?: string[] }): string {
  return (
    extractTaskIdFromLabels(issue.labels) ||
    extractTaskIdFromTitle(String(issue.title || "")) ||
    extractTaskIdFromIssueBody(String(issue.body || ""))
  );
}

function parseRepository(repository: string): { owner: string; repo: string } {
  const trimmed = ensureString(repository, "repository");
  const parts = trimmed.split("/").filter(Boolean);
  if (parts.length !== 2) {
    fail(`repository must be <owner>/<repo>: ${repository}`);
  }
  return { owner: parts[0], repo: parts[1] };
}

function resolveRequiredRepository(flags: Map<string, string | true>): string {
  mustNotBoolFlag(flags, "repository");
  const repository = getFlag(flags, "repository");
  if (!repository) {
    fail("--repository is required");
  }
  parseRepository(repository);
  return repository;
}

function canonicalRepositorySlug(repository: string): string {
  const parsed = parseRepository(repository);
  return `${parsed.owner.toLowerCase()}/${parsed.repo.toLowerCase()}`;
}

function assertIssueReferenceRepository(
  repository: string,
  referenceRepository: string,
  field: string
): void {
  if (!referenceRepository) return;
  if (canonicalRepositorySlug(repository) !== canonicalRepositorySlug(referenceRepository)) {
    fail(
      [
        `${field} repository mismatch`,
        `expected=${repository}`,
        `actual=${referenceRepository}`,
      ].join(" | ")
    );
  }
}

function parseIssueLabels(raw: unknown): string[] {
  const labelsRaw = Array.isArray(raw) ? raw : [];
  return labelsRaw
    .map((label) => {
      if (typeof label === "string") return label.trim();
      if (label && typeof label === "object" && !Array.isArray(label)) {
        return String((label as Record<string, unknown>).name || "").trim();
      }
      return "";
    })
    .filter(Boolean);
}

function parseRemoteTaskIssue(raw: unknown, source: string): RemoteTaskIssue {
  const entry = ensureObject(raw, source);
  const number = Number(entry.number || 0);
  if (!Number.isInteger(number) || number <= 0) {
    fail(`${source} returned invalid issue number`);
  }

  return {
    number,
    title: String(entry.title || ""),
    state: String(entry.state || "OPEN"),
    body: String(entry.body || ""),
    url: String(entry.url || ""),
    labels: parseIssueLabels(entry.labels),
  };
}

function parseRemoteTaskIssueList(raw: unknown, source: string): RemoteTaskIssue[] {
  if (!Array.isArray(raw)) {
    fail(`${source} response must be a JSON array`);
  }
  const issues: RemoteTaskIssue[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    issues.push(parseRemoteTaskIssue(entry, source));
  }
  return issues;
}

function isClosedIssue(issue: { state?: string }): boolean {
  return (
    String(issue.state || "OPEN")
      .trim()
      .toLowerCase() === "closed"
  );
}

export function collectOpenIssueTargetsByTaskId(
  taskId: string,
  issues: Array<{
    number: number;
    title?: string;
    body?: string;
    url?: string;
    labels?: string[];
    state?: string;
  }>
): UpsertTargetIssue[] {
  const targets: UpsertTargetIssue[] = [];
  for (const issue of issues) {
    if (isClosedIssue(issue)) continue;
    if (resolveRemoteTaskId(issue) !== taskId) continue;
    const number = Number(issue.number || 0);
    if (!Number.isInteger(number) || number <= 0) continue;
    targets.push({
      number,
      url: String(issue.url || "").trim(),
    });
  }
  return targets;
}

function fetchIssueByNumber(repository: string, issueNumber: number): RemoteTaskIssue {
  const issueRoute = `repos/${repository}/issues/${issueNumber}`;
  const result = runResult("gh", ["api", issueRoute], process.cwd());
  if (result.status !== 0) {
    const detail = `${result.stderr}\n${result.stdout}`.trim();
    if (/\b404\b/i.test(detail) || /not found|could not resolve/i.test(detail)) {
      fail(`issue #${issueNumber} was not found in ${repository}`);
    }
    fail(`failed to resolve issue #${issueNumber}: ${detail || `exit=${result.status}`}`);
  }
  return parseRemoteTaskIssue(
    parseJson(result.stdout || "{}", `gh api ${issueRoute}`),
    `gh api ${issueRoute}`
  );
}

function searchOpenTaskIssuesByTaskId(repository: string, taskId: string): RemoteTaskIssue[] {
  const stdout = run(
    "gh",
    [
      "search",
      "issues",
      taskId,
      "--repo",
      repository,
      "--state",
      "open",
      "--label",
      "task",
      "--limit",
      String(TASK_SEARCH_RESULT_LIMIT),
      "--json",
      ISSUE_JSON_FIELDS,
    ],
    process.cwd()
  );
  const issues = parseRemoteTaskIssueList(
    parseJson(stdout || "[]", "gh search issues"),
    "gh search issues"
  );
  if (issues.length >= TASK_SEARCH_RESULT_LIMIT) {
    fail(
      `task_id search reached limit (${TASK_SEARCH_RESULT_LIMIT}) for ${taskId}; narrow the query or implement pagination`
    );
  }
  return issues;
}

function resolveTargetIssue(repository: string, item: UpsertItem): UpsertTargetIssue | null {
  if (item.issueNumber > 0) {
    const remote = fetchIssueByNumber(repository, item.issueNumber);
    if (isClosedIssue(remote)) {
      fail(`issue #${item.issueNumber} is closed; upsert refuses to update closed task issues`);
    }
    const remoteTaskId = resolveRemoteTaskId(remote);
    if (remoteTaskId && remoteTaskId !== item.taskIdHint) {
      fail(
        `issue #${item.issueNumber} task_id mismatch: remote=${remoteTaskId} payload=${item.taskIdHint}`
      );
    }
    return {
      number: remote.number,
      url: remote.url || `https://github.com/${repository}/issues/${remote.number}`,
    };
  }

  const candidates = searchOpenTaskIssuesByTaskId(repository, item.taskIdHint);
  const matches = collectOpenIssueTargetsByTaskId(item.taskIdHint, candidates).map((target) => ({
    number: target.number,
    url: target.url || `https://github.com/${repository}/issues/${target.number}`,
  }));
  if (matches.length > 1) {
    const numbers = matches.map((entry) => `#${entry.number}`).join(", ");
    fail(`task_id ${item.taskIdHint} resolves to multiple issues: ${numbers}`);
  }
  return matches[0] || null;
}

function ensureTaskId(taskId: string, field: string): string {
  const normalized = ensureString(taskId, field);
  if (!TASK_ID_PATTERN.test(normalized)) {
    fail(`${field} is invalid: ${normalized}`);
  }
  return normalized;
}

function parseUpsertItems(raw: unknown): UpsertItem[] {
  const payload = ensureObject(raw, "upsert");
  if (!Array.isArray(payload.items)) {
    fail("upsert payload must be an object with items array");
  }
  const entries = payload.items;
  if (entries.length === 0) {
    fail("upsert payload must contain at least one issue item");
  }
  const seenTaskIds = new Set<string>();
  return entries.map((entry, index) => {
    const item = ensureObject(entry, `upsert.items[${index}]`);
    const unsupportedIssueAliases = ["issueNumber", "number"];
    for (const key of unsupportedIssueAliases) {
      if (Object.hasOwn(item, key)) {
        fail(`upsert.items[${index}].${key} is unsupported (use issue_number)`);
      }
    }
    const unsupportedParentKeys = [
      "parent_issue",
      "parent_issue_number",
      "parent_issue_url",
      "parentIssue",
      "parentIssueNumber",
      "parentIssueUrl",
    ];
    for (const key of unsupportedParentKeys) {
      if (Object.hasOwn(item, key)) {
        fail(`upsert.items[${index}].${key} is unsupported (use --parent-issue)`);
      }
    }
    if (Object.hasOwn(item, "taskId")) {
      fail(`upsert.items[${index}].taskId is unsupported (use task_id)`);
    }
    const allowedKeys = new Set(["issue", "issue_number", "task_id"]);
    for (const key of Object.keys(item)) {
      if (!allowedKeys.has(key)) {
        fail(`upsert.items[${index}].${key} is unsupported`);
      }
    }
    if (!Object.hasOwn(item, "issue")) {
      fail(`upsert.items[${index}].issue is required`);
    }
    if (!Object.hasOwn(item, "task_id")) {
      fail(`upsert.items[${index}].task_id is required`);
    }

    const issueField = `upsert.items[${index}].issue`;
    const issue = normalizeIssuePayload(item.issue, issueField);

    const issueNumberRaw = item.issue_number;
    const issueNumber =
      issueNumberRaw === undefined || issueNumberRaw === null || issueNumberRaw === ""
        ? 0
        : ensureInteger(issueNumberRaw, `upsert.items[${index}].issue_number`);

    const taskId = ensureTaskId(
      String(item.task_id || "").trim(),
      `upsert.items[${index}].task_id`
    );
    if (seenTaskIds.has(taskId)) {
      fail(`upsert payload contains duplicate task_id: ${taskId}`);
    }
    seenTaskIds.add(taskId);

    return {
      issue,
      issueNumber,
      taskIdHint: taskId,
      parentIssueNumber: 0,
    };
  });
}

export function parseUpsertItemsForCommand(raw: unknown, command: string): UpsertItem[] {
  if (command !== "upsert-task-issues") {
    fail(`unsupported upsert command: ${command}`);
  }
  return parseUpsertItems(raw);
}

function createTempFile(content: string): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orchestrate-plan-issue-runtime-"));
  const file = path.join(dir, "body.md");
  writeFileSync(file, content, "utf8");
  return {
    file,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function ensureLabelExists(repository: string, label: string): void {
  const encoded = encodeURIComponent(label);
  const get = runResult("gh", ["api", `repos/${repository}/labels/${encoded}`], process.cwd());
  if (get.status === 0) return;

  const create = runResult(
    "gh",
    [
      "api",
      "-X",
      "POST",
      `repos/${repository}/labels`,
      "-f",
      `name=${label}`,
      "-f",
      "color=ededed",
      "-f",
      "description=auto-created by orchestrate-plan upsert",
    ],
    process.cwd()
  );

  if (create.status === 0) return;

  const detail = `${create.stderr}\n${create.stdout}`;
  if (detail.includes("already_exists")) return;

  fail(`failed to ensure label '${label}': ${detail.trim() || `exit=${create.status}`}`);
}

function ensureLabelsExist(repository: string, labels: string[]): void {
  for (const label of labels) {
    ensureLabelExists(repository, label);
  }
}

function setIssueLabels(repository: string, issueNumber: number, labels: string[]): void {
  const args = ["api", "-X", "PUT", `repos/${repository}/issues/${issueNumber}/labels`];
  for (const label of labels) {
    args.push("-f", `labels[]=${label}`);
  }
  run("gh", args, process.cwd());
}

function fetchParentIssueNumber(repository: string, issueNumber: number): number {
  const result = runResult(
    "gh",
    ["api", `repos/${repository}/issues/${issueNumber}/parent`],
    process.cwd()
  );
  if (result.status !== 0) {
    const detail = `${result.stderr}\n${result.stdout}`.trim();
    if (/\b404\b/i.test(detail) || /not found/i.test(detail)) {
      return 0;
    }
    fail(
      `failed to resolve parent issue for #${issueNumber}: ${detail || `exit=${result.status}`}`
    );
  }

  const payload = ensureObject(
    parseJson(result.stdout || "{}", "gh api issue parent"),
    "gh api issue parent response"
  );
  const parentNumber = Number(payload.number || 0);
  if (!Number.isInteger(parentNumber) || parentNumber <= 0) {
    fail(`gh api issue parent returned invalid issue number for #${issueNumber}`);
  }
  return parentNumber;
}

function fetchIssueRestId(repository: string, issueNumber: number): number {
  const result = runResult(
    "gh",
    ["api", `repos/${repository}/issues/${issueNumber}`],
    process.cwd()
  );
  if (result.status !== 0) {
    const detail = `${result.stderr}\n${result.stdout}`.trim();
    fail(`failed to resolve issue id for #${issueNumber}: ${detail || `exit=${result.status}`}`);
  }
  const payload = ensureObject(
    parseJson(result.stdout || "{}", "gh api issue"),
    "gh api issue response"
  );
  const issueId = Number(payload.id || 0);
  if (!Number.isInteger(issueId) || issueId <= 0) {
    fail(`gh api issue returned invalid id for #${issueNumber}`);
  }
  return issueId;
}

function ensureSubIssueLink(
  repository: string,
  parentIssueNumber: number,
  childIssueNumber: number
): SubIssueLinkState {
  if (parentIssueNumber <= 0) return "not_requested";
  if (parentIssueNumber === childIssueNumber) {
    fail(`issue #${childIssueNumber} cannot be its own parent issue`);
  }

  const currentParent = fetchParentIssueNumber(repository, childIssueNumber);
  if (currentParent === parentIssueNumber) {
    return "already_linked";
  }
  if (currentParent > 0 && currentParent !== parentIssueNumber) {
    fail(
      [
        `issue #${childIssueNumber} already has parent issue`,
        `current=#${currentParent}`,
        `requested=#${parentIssueNumber}`,
      ].join(" | ")
    );
  }

  // GitHub sub-issue endpoint expects REST issue id, not issue number.
  const link = runResult(
    "gh",
    [
      "api",
      "-X",
      "POST",
      `repos/${repository}/issues/${parentIssueNumber}/sub_issues`,
      "-F",
      `sub_issue_id=${fetchIssueRestId(repository, childIssueNumber)}`,
    ],
    process.cwd()
  );
  if (link.status !== 0) {
    const detail = `${link.stderr}\n${link.stdout}`.trim();
    if (/already/i.test(detail) && /sub-?issue|parent/i.test(detail)) {
      return "already_linked";
    }
    fail(
      [
        `failed to link issue #${childIssueNumber} under parent #${parentIssueNumber}`,
        detail || `exit=${link.status}`,
      ].join(": ")
    );
  }
  return "linked";
}

function planSubIssueLinkState(
  repository: string,
  parentIssueNumber: number,
  childIssueNumber: number
): SubIssueLinkState {
  if (parentIssueNumber <= 0) return "not_requested";
  if (parentIssueNumber === childIssueNumber) {
    fail(`issue #${childIssueNumber} cannot be its own parent issue`);
  }

  const currentParent = fetchParentIssueNumber(repository, childIssueNumber);
  if (currentParent === parentIssueNumber) {
    return "already_linked";
  }
  if (currentParent > 0 && currentParent !== parentIssueNumber) {
    fail(
      [
        `issue #${childIssueNumber} already has parent issue`,
        `current=#${currentParent}`,
        `requested=#${parentIssueNumber}`,
      ].join(" | ")
    );
  }

  return "link_planned";
}

function createIssue(repository: string, payload: IssuePayload): UpsertTargetIssue {
  const tmp = createTempFile(payload.body);
  try {
    const args = [
      "issue",
      "create",
      "--repo",
      repository,
      "--title",
      payload.title,
      "--body-file",
      tmp.file,
    ];
    for (const label of payload.labels) {
      args.push("--label", label);
    }

    const stdout = run("gh", args, process.cwd());
    const matched = stdout.match(/https:\/\/github\.com\/[^\s]+\/issues\/(\d+)/);
    if (!matched) {
      fail(`failed to parse created issue URL from gh output: ${stdout}`);
    }
    const number = Number(matched[1]);
    if (!Number.isInteger(number) || number <= 0) {
      fail(`failed to parse created issue number from gh output: ${stdout}`);
    }
    return {
      number,
      url: matched[0],
    };
  } finally {
    tmp.cleanup();
  }
}

function updateIssue(
  repository: string,
  issueNumber: number,
  payload: IssuePayload
): UpsertTargetIssue {
  const tmp = createTempFile(payload.body);
  try {
    run(
      "gh",
      [
        "issue",
        "edit",
        String(issueNumber),
        "--repo",
        repository,
        "--title",
        payload.title,
        "--body-file",
        tmp.file,
      ],
      process.cwd()
    );
  } finally {
    tmp.cleanup();
  }

  setIssueLabels(repository, issueNumber, payload.labels);
  return {
    number: issueNumber,
    url: `https://github.com/${repository}/issues/${issueNumber}`,
  };
}

function resolveSingleIssueNumberFlag(flags: Map<string, string | true>): number {
  mustNotBoolFlag(flags, "issue-number");
  const raw = getFlag(flags, "issue-number");
  if (!raw) return 0;
  return ensureInteger(raw, "issue-number");
}

function applySingleIssueNumber(items: UpsertItem[], issueNumber: number): UpsertItem[] {
  if (issueNumber <= 0) return items;
  if (items.length !== 1) {
    fail("--issue-number can only be used with a single issue payload");
  }

  return [
    {
      ...items[0],
      issueNumber,
    },
  ];
}

function resolveParentIssueReferenceFlag(flags: Map<string, string | true>): IssueReference | null {
  mustNotBoolFlag(flags, "parent-issue");
  const raw = getFlag(flags, "parent-issue");
  if (!raw) {
    return null;
  }
  return parseIssueReference(raw, "parent-issue");
}

function applyParentIssueReference(
  items: UpsertItem[],
  parentIssueRef: IssueReference | null
): UpsertItem[] {
  if (!parentIssueRef) {
    return items;
  }
  return items.map((item) => ({
    ...item,
    parentIssueNumber: parentIssueRef.issueNumber,
  }));
}

function assertParentIssueContract(
  items: UpsertItem[],
  parentIssueRef: IssueReference | null
): void {
  if (items.length > 1 && !parentIssueRef) {
    fail("--parent-issue is required when upserting multiple task issues");
  }
}

export function applyParentIssueReferenceForCommand(
  items: UpsertItem[],
  parentIssueValue?: string | number
): UpsertItem[] {
  const normalizedValue = String(parentIssueValue ?? "").trim();
  const parentIssueRef = normalizedValue
    ? parseIssueReference(parentIssueValue ?? "", "parent_issue")
    : null;
  return applyParentIssueReference(items, parentIssueRef);
}

function upsertIssues(
  items: UpsertItem[],
  repository: string,
  dryRun: boolean,
  createOnly: boolean
): UpsertResult[] {
  const ordered = [...items].sort((left, right) => {
    const byTask = left.taskIdHint.localeCompare(right.taskIdHint);
    if (byTask !== 0) return byTask;
    return left.issue.title.localeCompare(right.issue.title);
  });

  const results: UpsertResult[] = [];
  const resolvedByTaskId = new Map<string, UpsertTargetIssue>();

  for (const item of ordered) {
    const payload = {
      ...item.issue,
      labels: uniqueStrings(item.issue.labels),
    };

    let target = resolvedByTaskId.get(item.taskIdHint) || null;
    if (!target) {
      target = resolveTargetIssue(repository, item);
    } else if (item.issueNumber > 0 && item.issueNumber !== target.number) {
      fail(
        [
          `task_id ${item.taskIdHint} is referenced by multiple issue numbers in a single upsert payload`,
          `cached=#${target.number}`,
          `requested=#${item.issueNumber}`,
        ].join(" | ")
      );
    }

    if (createOnly && target) {
      fail(
        `task_id ${item.taskIdHint} already exists as #${target.number}; create-only mode refuses updates`
      );
    }

    if (dryRun) {
      let subIssueLinkState: SubIssueLinkState = "not_requested";
      if (item.parentIssueNumber > 0) {
        if (target?.number && target.number > 0) {
          subIssueLinkState = planSubIssueLinkState(
            repository,
            item.parentIssueNumber,
            target.number
          );
        } else {
          subIssueLinkState = "link_planned";
        }
      }
      results.push({
        action: target ? "update_planned" : "create_planned",
        repository,
        task_id: item.taskIdHint,
        issue_number: target?.number || 0,
        issue_url: target?.url || "",
        title: payload.title,
        parent_issue_number: item.parentIssueNumber > 0 ? item.parentIssueNumber : undefined,
        sub_issue_link_state: subIssueLinkState,
      });
      continue;
    }

    ensureLabelsExist(repository, payload.labels);

    let resolved: UpsertTargetIssue;
    let action: UpsertAction;
    if (target) {
      resolved = updateIssue(repository, target.number, payload);
      action = "updated";
    } else {
      resolved = createIssue(repository, payload);
      action = "created";
    }

    const subIssueLinkState = ensureSubIssueLink(
      repository,
      item.parentIssueNumber,
      resolved.number
    );

    resolvedByTaskId.set(item.taskIdHint, resolved);
    results.push({
      action,
      repository,
      task_id: item.taskIdHint,
      issue_number: resolved.number,
      issue_url: resolved.url,
      title: payload.title,
      parent_issue_number: item.parentIssueNumber > 0 ? item.parentIssueNumber : undefined,
      sub_issue_link_state: subIssueLinkState,
    });
  }

  return results;
}

async function main(argv: string[]): Promise<void> {
  await Promise.resolve();
  const { command, flags } = parseCli(argv);
  const outputPath = getFlag(flags, "output");

  if (command === "upsert-task-issues") {
    const repository = resolveRequiredRepository(flags);
    const inputPath = getFlag(flags, "input");
    const rawPayload = readJsonFromInput(inputPath);
    const parsedItems = parseUpsertItemsForCommand(rawPayload, command);
    const issueNumber = resolveSingleIssueNumberFlag(flags);
    const parentIssueRef = resolveParentIssueReferenceFlag(flags);
    assertParentIssueContract(parsedItems, parentIssueRef);
    if (parentIssueRef?.repository) {
      assertIssueReferenceRepository(repository, parentIssueRef.repository, "parent-issue");
    }
    const items = applyParentIssueReference(
      applySingleIssueNumber(parsedItems, issueNumber),
      parentIssueRef
    );
    const dryRun = hasBoolFlag(flags, "dry-run");
    const createOnly = hasBoolFlag(flags, "create-only");

    const results = upsertIssues(items, repository, dryRun, createOnly);
    writeJsonOutput(
      {
        generated_at: nowIsoUtc(),
        repository,
        dry_run: dryRun,
        create_only: createOnly,
        count: results.length,
        results,
      },
      outputPath
    );
    return;
  }

  fail(`unknown command: ${command}\n\n${usage()}`);
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`issue-runtime failed: ${(error as Error).message}`);
    process.exit(1);
  });
}
