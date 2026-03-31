#!/usr/bin/env bun

import path from "node:path";
import { Command } from "commander";
import {
  fail,
  isObject,
  type JsonObject,
  parseJson,
  resolveRepoRoot,
  runGh,
  writeOutput,
} from "../../adapters/cli";
import { resolveRepository } from "../../core/task-governance";

type Cli = {
  repository: string;
  apply: boolean;
  allParents: boolean;
  parentIssues: number[];
  outputPath: string;
};

type SubIssue = {
  number: number;
  state: "OPEN" | "CLOSED";
  title: string;
};

type ParentJudgment = {
  issue_number: number;
  issue_title: string;
  current_state: "OPEN" | "CLOSED";
  sub_issues: SubIssue[];
  judgment: "close" | "reopen" | "none";
  reason: string;
  fail_closed: boolean;
  applied: boolean;
};

export type ParentSyncPlan = {
  parents: ParentJudgment[];
  close_count: number;
  reopen_count: number;
  skip_count: number;
  fail_closed_count: number;
};

export function normalizeRequestedParentIssues(values: number[]): number[] {
  const unique = new Set<number>();
  for (const value of values) {
    if (!Number.isInteger(value) || value <= 0) {
      fail(`parent issue number must be a positive integer: ${value}`);
    }
    unique.add(value);
  }
  return [...unique].sort((left, right) => left - right);
}

export function parseCli(argv: string[]): Cli {
  const program = new Command()
    .name("sync-parent-issue-status")
    .description("Sync parent issue open/closed state based on sub-issue status")
    .requiredOption("--repository <owner/repo>", "Target repository slug")
    .option("--apply", "Apply close/reopen (default: dry-run)", false)
    .option("--dry-run", "Explicit dry-run (default behavior)")
    .option(
      "--all-parents",
      "Manual opt-in: scan every parent issue in the repository instead of requiring an explicit bounded set.",
      false
    )
    .option(
      "--parent-issue <number>",
      "Filter to a single parent issue. Repeat to sync an explicit bounded set.",
      (value: string, previous: number[] = []) => {
        const issueNumber = Number(value);
        if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
          fail(`--parent-issue must be a positive integer: ${value}`);
        }
        return [...previous, issueNumber];
      },
      []
    )
    .option("--output <path>", "Write summary JSON")
    .addHelpText(
      "after",
      [
        "",
        "Rules:",
        "  - Close: all sub-issues CLOSED",
        "  - Reopen: any sub-issue OPEN and parent is CLOSED",
        "  - Fail-closed: no change on judgment failure",
        "  - Standard path requires one or more --parent-issue values",
        "  - --all-parents is a manual opt-in for repo-wide discovery",
      ].join("\n")
    )
    .parse(["node", "sync-parent-issue-status", ...argv]);

  const opts = program.opts<{
    repository: string;
    apply: boolean;
    allParents?: boolean;
    dryRun?: boolean;
    parentIssue?: number[];
    output?: string;
  }>();

  const repo = resolveRepository(opts.repository);

  // --dry-run explicitly overrides --apply
  const apply = opts.dryRun === true ? false : opts.apply;
  const allParents = opts.allParents === true;
  const parentIssues = normalizeRequestedParentIssues(opts.parentIssue ?? []);
  if (!allParents && parentIssues.length === 0) {
    fail(
      "sync-parent-issue-status requires --parent-issue <number> (repeatable) or explicit --all-parents"
    );
  }
  if (allParents && parentIssues.length > 0) {
    fail("--all-parents cannot be combined with --parent-issue");
  }

  return {
    repository: `${repo.owner}/${repo.repo}`,
    apply,
    allParents,
    parentIssues,
    outputPath: opts.output ? path.resolve(opts.output) : "",
  };
}

/**
 * Maximum issues/sub-issues fetched per REST page.
 * Exported for use in tests.
 */
export const SUB_ISSUES_PAGE_SIZE = 100;

type ParentIssueRaw = {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED";
  subIssues: Array<{
    number: number;
    state: "OPEN" | "CLOSED";
    title: string;
  }>;
  /** Total count reported by GitHub (from totalCount field). -1 if unknown. */
  subIssueTotalCount: number;
  /** True when the fetched sub-issues are known to be incomplete. */
  subIssuesTruncated: boolean;
};

function readParentIssues(
  repoRoot: string,
  repository: string,
  allParents: boolean,
  requestedParents: number[]
): ParentIssueRaw[] {
  if (requestedParents.length > 0) {
    return requestedParents.map((parentNumber) =>
      readSingleParentIssue(repoRoot, repository, parentNumber)
    );
  }
  if (!allParents) {
    fail("readParentIssues requires explicit parent issues unless --all-parents is set");
  }
  return readAllParentIssues(repoRoot, repository);
}

function readSingleParentIssue(
  repoRoot: string,
  repository: string,
  parentNumber: number
): ParentIssueRaw {
  const parentIssue = readRestIssue(repoRoot, repository, parentNumber);
  const parent = normalizeParentIssue(parentIssue);
  parent.subIssues = readRestSubIssues(repoRoot, repository, parent.number);
  parent.subIssuesTruncated =
    parent.subIssueTotalCount >= 0 && parent.subIssues.length !== parent.subIssueTotalCount;
  return parent;
}

function readAllParentIssues(repoRoot: string, repository: string): ParentIssueRaw[] {
  const pages = readPaginatedRestArray(
    repoRoot,
    `repos/${repository}/issues?state=all&per_page=${SUB_ISSUES_PAGE_SIZE}`,
    "rest issues"
  );

  const parents: ParentIssueRaw[] = [];
  for (const issue of pages) {
    if (!isObject(issue)) continue;
    if (issue.pull_request) continue;
    const summary = isObject(issue.sub_issues_summary)
      ? (issue.sub_issues_summary as JsonObject)
      : null;
    const total = Number(summary?.total || 0);
    if (!Number.isInteger(total) || total <= 0) continue;

    const parent = normalizeParentIssue(issue);
    parent.subIssues = readRestSubIssues(repoRoot, repository, parent.number);
    parent.subIssuesTruncated =
      parent.subIssueTotalCount >= 0 && parent.subIssues.length !== parent.subIssueTotalCount;
    parents.push(parent);
  }

  return parents;
}

function readRestIssue(repoRoot: string, repository: string, issueNumber: number): JsonObject {
  const stdout = runGh(["api", `repos/${repository}/issues/${issueNumber}`], { cwd: repoRoot });
  const parsed = parseJson(stdout || "{}", "rest issue");
  if (!isObject(parsed)) {
    fail(`REST issue response must be an object for #${issueNumber}`);
  }
  return parsed;
}

export function parsePaginatedRestArray(raw: unknown, source: string): JsonObject[] {
  if (!Array.isArray(raw)) {
    fail(`${source} response must be an array of pages`);
  }
  const items: JsonObject[] = [];
  for (const page of raw) {
    if (!Array.isArray(page)) {
      fail(`${source} page must be an array`);
    }
    for (const entry of page) {
      if (isObject(entry)) {
        items.push(entry);
      }
    }
  }
  return items;
}

function readPaginatedRestArray(repoRoot: string, endpoint: string, source: string): JsonObject[] {
  const stdout = runGh(["api", endpoint, "--paginate", "--slurp"], { cwd: repoRoot });
  const parsed = parseJson(stdout || "[]", source);
  return parsePaginatedRestArray(parsed, source);
}

export function normalizeSubIssues(
  raw: JsonObject[],
  parentNumber: number
): ParentIssueRaw["subIssues"] {
  const subIssues: ParentIssueRaw["subIssues"] = [];
  for (const sub of raw) {
    const subNumber = Number(sub.number || 0);
    const subState = String(sub.state || "")
      .trim()
      .toUpperCase();
    const subTitle = String(sub.title || "").trim();
    if (!Number.isInteger(subNumber) || subNumber <= 0) continue;
    if (subState !== "OPEN" && subState !== "CLOSED") {
      fail(`sub-issue #${subNumber} of parent #${parentNumber} has unexpected state: ${subState}`);
    }
    subIssues.push({
      number: subNumber,
      state: subState as "OPEN" | "CLOSED",
      title: subTitle,
    });
  }
  return subIssues;
}

function readRestSubIssues(
  repoRoot: string,
  repository: string,
  parentNumber: number
): ParentIssueRaw["subIssues"] {
  const pages = readPaginatedRestArray(
    repoRoot,
    `repos/${repository}/issues/${parentNumber}/sub_issues?per_page=${SUB_ISSUES_PAGE_SIZE}`,
    "rest sub-issues"
  );
  return normalizeSubIssues(pages, parentNumber);
}

export function normalizeParentIssue(raw: JsonObject): ParentIssueRaw {
  const number = Number(raw.number || 0);
  if (!Number.isInteger(number) || number <= 0) {
    fail("parent issue number must be a positive integer");
  }
  const title = String(raw.title || "").trim();
  const stateRaw = String(raw.state || "")
    .trim()
    .toUpperCase();
  if (stateRaw !== "OPEN" && stateRaw !== "CLOSED") {
    fail(`parent issue #${number} has unexpected state: ${stateRaw}`);
  }
  const subIssuesRaw = raw.subIssues ?? raw.sub_issues;

  let subIssueTotalCount = -1;
  const summary = isObject(raw.sub_issues_summary) ? (raw.sub_issues_summary as JsonObject) : null;
  if (summary && typeof summary.total === "number") {
    subIssueTotalCount = summary.total;
  } else if (
    isObject(subIssuesRaw) &&
    typeof (subIssuesRaw as JsonObject).totalCount === "number"
  ) {
    subIssueTotalCount = Number((subIssuesRaw as JsonObject).totalCount);
  }

  let subNodes: unknown[];
  if (Array.isArray(subIssuesRaw)) {
    subNodes = subIssuesRaw;
  } else if (isObject(subIssuesRaw) && Array.isArray((subIssuesRaw as JsonObject).nodes)) {
    subNodes = (subIssuesRaw as JsonObject).nodes as unknown[];
  } else {
    subNodes = [];
  }

  const subIssues: ParentIssueRaw["subIssues"] = [];
  for (const sub of subNodes) {
    if (!isObject(sub)) continue;
    const subNumber = Number(sub.number || 0);
    const subState = String(sub.state || "")
      .trim()
      .toUpperCase();
    const subTitle = String(sub.title || "").trim();
    if (!Number.isInteger(subNumber) || subNumber <= 0) continue;
    if (subState !== "OPEN" && subState !== "CLOSED") {
      fail(`sub-issue #${subNumber} of parent #${number} has unexpected state: ${subState}`);
    }
    subIssues.push({ number: subNumber, state: subState, title: subTitle });
  }

  const subIssuesTruncated =
    subIssueTotalCount >= 0 ? subIssues.length !== subIssueTotalCount : false;

  return { number, title, state: stateRaw, subIssues, subIssueTotalCount, subIssuesTruncated };
}

export function buildParentSyncPlan(parents: ParentIssueRaw[]): ParentSyncPlan {
  const judgments: ParentJudgment[] = [];
  let closeCount = 0;
  let reopenCount = 0;
  let skipCount = 0;
  let failClosedCount = 0;

  for (const parent of parents) {
    const subIssues: SubIssue[] = parent.subIssues.map((sub) => ({
      number: sub.number,
      state: sub.state,
      title: sub.title,
    }));

    if (subIssues.length === 0) {
      if (parent.state === "OPEN") {
        judgments.push({
          issue_number: parent.number,
          issue_title: parent.title,
          current_state: parent.state,
          sub_issues: subIssues,
          judgment: "none",
          reason:
            "open parent has no linked child tasks; normalize the successor child task or close the parent before reconciliation (fail-closed)",
          fail_closed: true,
          applied: false,
        });
        skipCount += 1;
        failClosedCount += 1;
        continue;
      }
      skipCount += 1;
      continue;
    }

    // Fail-closed: refuse to make a judgment if sub-issues are truncated (incomplete data)
    if (parent.subIssuesTruncated) {
      const totalInfo =
        parent.subIssueTotalCount >= 0
          ? ` (totalCount=${parent.subIssueTotalCount}, fetched=${subIssues.length})`
          : ` (fetched=${subIssues.length})`;
      judgments.push({
        issue_number: parent.number,
        issue_title: parent.title,
        current_state: parent.state,
        sub_issues: subIssues,
        judgment: "none",
        reason: `sub-issues truncated, judgment refused (fail-closed)${totalInfo}`,
        fail_closed: true,
        applied: false,
      });
      skipCount += 1;
      failClosedCount += 1;
      continue;
    }

    const judgment = judgeParentState(parent.state, subIssues);
    judgments.push({
      issue_number: parent.number,
      issue_title: parent.title,
      current_state: parent.state,
      sub_issues: subIssues,
      judgment: judgment.action,
      reason: judgment.reason,
      fail_closed: false,
      applied: false,
    });

    if (judgment.action === "close") closeCount += 1;
    else if (judgment.action === "reopen") reopenCount += 1;
    else skipCount += 1;
  }

  judgments.sort((a, b) => a.issue_number - b.issue_number);
  return {
    parents: judgments,
    close_count: closeCount,
    reopen_count: reopenCount,
    skip_count: skipCount,
    fail_closed_count: failClosedCount,
  };
}

export function judgeParentState(
  parentState: "OPEN" | "CLOSED",
  subIssues: SubIssue[]
): { action: "close" | "reopen" | "none"; reason: string } {
  if (subIssues.length === 0) {
    return { action: "none", reason: "no sub-issues" };
  }

  const allSubsClosed = subIssues.every((s) => s.state === "CLOSED");
  const anySubOpen = subIssues.some((s) => s.state === "OPEN");

  if (parentState === "OPEN" && allSubsClosed) {
    return { action: "close", reason: "all sub-issues CLOSED" };
  }

  if (parentState === "CLOSED" && anySubOpen) {
    return {
      action: "reopen",
      reason: `parent CLOSED but sub-issues OPEN: ${subIssues
        .filter((s) => s.state === "OPEN")
        .map((s) => `#${s.number}`)
        .join(", ")}`,
    };
  }

  return { action: "none", reason: "no state change needed" };
}

function applyPlan(repoRoot: string, repository: string, plan: ParentSyncPlan): number {
  let applied = 0;
  for (const judgment of plan.parents) {
    if (judgment.judgment === "none") continue;
    const targetState = judgment.judgment === "close" ? "closed" : "open";
    runGh(
      [
        "api",
        "-X",
        "PATCH",
        `repos/${repository}/issues/${judgment.issue_number}`,
        "-F",
        `state=${targetState}`,
      ],
      { cwd: repoRoot }
    );
    judgment.applied = true;
    applied += 1;
  }
  process.stdout.write(
    `${["parent issue sync apply completed", `repository=${repository}`, `applied=${applied}`].join(
      " | "
    )}\n`
  );
  return applied;
}

function main(): void {
  const cli = parseCli(process.argv.slice(2));
  const repoRoot = resolveRepoRoot();
  const parents = readParentIssues(repoRoot, cli.repository, cli.allParents, cli.parentIssues);
  const plan = buildParentSyncPlan(parents);

  if (plan.fail_closed_count > 0) {
    const summary = {
      generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      repository: cli.repository,
      mode: cli.apply ? "apply" : "dry-run",
      scope: cli.allParents ? "manual-repo-wide" : "explicit",
      requested_parent_issue_numbers: cli.parentIssues,
      close_count: plan.close_count,
      reopen_count: plan.reopen_count,
      skip_count: plan.skip_count,
      fail_closed_count: plan.fail_closed_count,
      applied_count: 0,
      parents: plan.parents,
      errors: [
        `parent issue reconciliation failed closed for ${plan.fail_closed_count} parent issue(s); normalize linked child coverage before retrying`,
      ] as string[],
    };

    writeOutput(cli.outputPath, summary);
    process.stdout.write(
      `${[
        "parent issue sync completed",
        `mode=${summary.mode}`,
        `repository=${summary.repository}`,
        `close=${summary.close_count}`,
        `reopen=${summary.reopen_count}`,
        `skip=${summary.skip_count}`,
        `fail_closed=${summary.fail_closed_count}`,
        `applied=${summary.applied_count}`,
        `output=${cli.outputPath || "(none)"}`,
      ].join(" | ")}\n`
    );
    process.exit(1);
  }

  const appliedCount = cli.apply ? applyPlan(repoRoot, cli.repository, plan) : 0;

  const summary = {
    generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    repository: cli.repository,
    mode: cli.apply ? "apply" : "dry-run",
    scope: cli.allParents ? "manual-repo-wide" : "explicit",
    requested_parent_issue_numbers: cli.parentIssues,
    close_count: plan.close_count,
    reopen_count: plan.reopen_count,
    skip_count: plan.skip_count,
    fail_closed_count: plan.fail_closed_count,
    applied_count: appliedCount,
    parents: plan.parents,
    errors: [] as string[],
  };

  writeOutput(cli.outputPath, summary);
  process.stdout.write(
    `${[
      "parent issue sync completed",
      `mode=${summary.mode}`,
      `repository=${summary.repository}`,
      `close=${summary.close_count}`,
      `reopen=${summary.reopen_count}`,
      `skip=${summary.skip_count}`,
      `fail_closed=${summary.fail_closed_count}`,
      `applied=${summary.applied_count}`,
      `output=${cli.outputPath || "(none)"}`,
    ].join(" | ")}\n`
  );

  if (!cli.apply && (plan.close_count > 0 || plan.reopen_count > 0)) {
    process.exit(1);
  }
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`sync-parent-issue-status failed: ${(error as Error).message}\n`);
    process.exit(1);
  }
}
