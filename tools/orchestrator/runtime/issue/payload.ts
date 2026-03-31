import { tryBuildTaskSpecFromIssueSnapshot } from "../../../core/task-governance";
import { parseIssueReference } from "./cli";
import { ensureInteger, ensureObject, ensureString, fail, uniqueStrings } from "./common";
import {
  buildSeparatedSurfaceValidationMetadata,
  type IssuePayload,
  type IssueReference,
  TASK_ID_HINT_PATTERN,
  TASK_ID_PATTERN,
  TASK_ID_SEARCH_PATTERN,
  type UpsertItem,
} from "./contracts";

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

function validateCanonicalTaskIssuePayload(
  issue: IssuePayload,
  taskId: string,
  field: string
): void {
  if (!String(issue.body || "").trim()) {
    fail(`${field}.body must not be empty`);
  }
  const titleTaskId = extractTaskIdFromTitle(issue.title);
  if (titleTaskId !== taskId) {
    fail(`${field}.title must encode task_id ${taskId}`);
  }
  const rebuilt = tryBuildTaskSpecFromIssueSnapshot({
    title: issue.title,
    body: issue.body,
    metadata: buildSeparatedSurfaceValidationMetadata(taskId),
  });
  if (rebuilt.errors.length > 0) {
    fail(
      `${field}.body is not a canonical task-spec-only issue body: ${rebuilt.errors.join("; ")}`
    );
  }
}

function ensureTaskId(taskId: string, field: string): string {
  const normalized = ensureString(taskId, field);
  if (!TASK_ID_PATTERN.test(normalized)) {
    fail(`${field} is invalid: ${normalized}`);
  }
  return normalized;
}

export function resolveRemoteTaskId(issue: {
  title?: string;
  body?: string;
  labels?: string[];
}): string {
  return extractTaskIdFromTitle(String(issue.title || ""));
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

    const taskId = ensureTaskId(
      String(item.task_id || "").trim(),
      `upsert.items[${index}].task_id`
    );
    if (seenTaskIds.has(taskId)) {
      fail(`upsert payload contains duplicate task_id: ${taskId}`);
    }
    seenTaskIds.add(taskId);

    const issueField = `upsert.items[${index}].issue`;
    const issue = normalizeIssuePayload(item.issue, issueField);
    validateCanonicalTaskIssuePayload(issue, taskId, issueField);

    const issueNumberRaw = item.issue_number;
    const issueNumber =
      issueNumberRaw === undefined || issueNumberRaw === null || issueNumberRaw === ""
        ? 0
        : ensureInteger(issueNumberRaw, `upsert.items[${index}].issue_number`);

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

export function applySingleIssueNumber(items: UpsertItem[], issueNumber: number): UpsertItem[] {
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

export function assertParentIssueContract(
  items: UpsertItem[],
  parentIssueRef: IssueReference | null
): void {
  if (items.length > 1 && !parentIssueRef) {
    fail("--parent-issue is required when upserting multiple task issues");
  }
}
