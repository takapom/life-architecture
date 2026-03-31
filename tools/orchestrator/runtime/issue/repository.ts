import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureObject, fail, parseJson, run, runResult } from "./common";
import {
  type IssuePayload,
  REST_ISSUES_PAGE_SIZE,
  type RemoteTaskIssue,
  TASK_SEARCH_RESULT_LIMIT,
  type UpsertItem,
  type UpsertTargetIssue,
} from "./contracts";
import { resolveRemoteTaskId } from "./payload";

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

function listOpenTaskIssues(repository: string): RemoteTaskIssue[] {
  const issues: RemoteTaskIssue[] = [];

  for (let page = 1; ; page += 1) {
    const route = `repos/${repository}/issues?state=open&labels=task&per_page=${REST_ISSUES_PAGE_SIZE}&page=${page}`;
    const stdout = run("gh", ["api", route], process.cwd());
    const pageIssues = parseRemoteTaskIssueList(
      parseJson(stdout || "[]", `gh api ${route}`),
      `gh api ${route}`
    );
    issues.push(...pageIssues);
    if (issues.length >= TASK_SEARCH_RESULT_LIMIT) {
      fail(
        `task issue listing reached limit (${TASK_SEARCH_RESULT_LIMIT}) for ${repository}; narrow the scope or implement a higher cap`
      );
    }
    if (pageIssues.length < REST_ISSUES_PAGE_SIZE) {
      return issues;
    }
  }
}

export function resolveTargetIssue(repository: string, item: UpsertItem): UpsertTargetIssue | null {
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

  const candidates = listOpenTaskIssues(repository);
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

function createTempFile(content: string): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orchestrate-plan-issue-runtime-"));
  const file = path.join(dir, "body.md");
  writeFileSync(file, content, "utf8");
  return {
    file,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export function createIssue(repository: string, payload: IssuePayload): UpsertTargetIssue {
  const tmp = createTempFile(payload.body);
  try {
    const stdout = run(
      "gh",
      ["issue", "create", "--repo", repository, "--title", payload.title, "--body-file", tmp.file],
      process.cwd()
    );
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

export function updateIssue(
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

  return {
    number: issueNumber,
    url: `https://github.com/${repository}/issues/${issueNumber}`,
  };
}
