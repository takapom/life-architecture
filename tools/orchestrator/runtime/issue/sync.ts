import { ensureObject, fail, parseJson, run, runResult } from "./common";
import type { SubIssueLinkState } from "./contracts";

export function syncIssueLabels(repository: string, issueNumber: number, labels: string[]): void {
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

export function ensureSubIssueLink(
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

export function planSubIssueLinkState(
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
