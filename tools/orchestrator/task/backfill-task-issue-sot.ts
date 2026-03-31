#!/usr/bin/env bun

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Command } from "commander";

import { fail, parseJson, runGh, writeOutput } from "../../adapters/cli";
import {
  auditTaskIssueSourceOfTruth,
  loadTaskIssues,
  normalizeSourceIssue,
  resolveRepository,
} from "../../core/task-governance";
import type { GraphIssueNode, TaskIssue } from "../../core/task-governance-types";

type Cli = {
  repository: string;
  sourcePath: string;
  outputPath: string;
  apply: boolean;
  issueNumbers: number[];
};

type RawIssueSnapshot = {
  number: number;
  title: string;
  body: string;
  html_url: string;
};

type TaskIssueSoTBackfillStatus = "certified" | "normalization_only" | "manual_review";

type TaskIssueSoTBackfillAnalysis = {
  issue_number: number;
  task_id: string;
  title: string;
  status: TaskIssueSoTBackfillStatus;
  can_apply: boolean;
  errors: string[];
  mismatches: string[];
  next_action: string;
  normalized_title: string;
  normalized_body: string;
};

type TaskIssueSoTBackfillReport = {
  open_task_count: number;
  certified_count: number;
  normalization_only_count: number;
  manual_review_count: number;
  failing_count: number;
  issues: TaskIssueSoTBackfillAnalysis[];
};

type OutputPayload = TaskIssueSoTBackfillReport & {
  generated_at: string;
  repository: string;
  apply: boolean;
  selected_issue_numbers: number[];
  applied_issue_numbers: number[];
};

function nowIsoUtc(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function parsePositiveIssueNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    fail(`invalid issue number: ${value}`);
  }
  return parsed;
}

function parseCli(argv: string[]): Cli {
  const program = new Command()
    .name("backfill-task-issue-sot")
    .description("Report or normalize open task issues against the canonical SoT split")
    .option("--repository <slug>", "Target repository <owner/repo>")
    .option("--source <path>", "Offline issue JSON source (report-only)")
    .option("--output <path>", "Write JSON report to a file")
    .option(
      "--apply",
      "Apply canonical title/body normalization for normalization-only issues",
      false
    )
    .option(
      "--issue-number <n>",
      "Limit processing to specific issue numbers (repeatable)",
      (value: string, previous: number[]) => [...previous, parsePositiveIssueNumber(value)],
      [] as number[]
    )
    .parse(["node", "backfill-task-issue-sot", ...argv]);

  const opts = program.opts<{
    repository?: string;
    source?: string;
    output?: string;
    apply: boolean;
    issueNumber: number[];
  }>();
  const repositoryRef = resolveRepository(String(opts.repository || ""));
  const sourcePath = String(opts.source || "").trim();
  const apply = Boolean(opts.apply);
  if (apply && sourcePath) {
    fail(
      "--apply does not support --source; fetch live GitHub issues for read-after-write verification"
    );
  }

  return {
    repository: `${repositoryRef.owner}/${repositoryRef.repo}`,
    sourcePath,
    outputPath: String(opts.output || "").trim(),
    apply,
    issueNumbers: [
      ...new Set((opts.issueNumber || []).map((entry) => Number(entry || 0)).filter(Boolean)),
    ],
  };
}

function selectOpenIssues(issues: TaskIssue[], issueNumbers: number[]): TaskIssue[] {
  const selected = issues.filter((issue) => issue.state === "open");
  if (issueNumbers.length === 0) return selected;
  const allowed = new Set(issueNumbers);
  const filtered = selected.filter((issue) => allowed.has(issue.number));
  const missing = issueNumbers.filter(
    (issueNumber) => !filtered.some((issue) => issue.number === issueNumber)
  );
  if (missing.length > 0) {
    fail(
      `requested open task issues were not found: ${missing.map((issueNumber) => `#${issueNumber}`).join(", ")}`
    );
  }
  return filtered;
}

function parseRawIssueSnapshotsFromFile(sourcePath: string): Map<number, RawIssueSnapshot> {
  const payload = parseJson(readFileSync(path.resolve(sourcePath), "utf8"), sourcePath);
  if (!Array.isArray(payload)) {
    fail(`offline issue source must be a JSON array: ${sourcePath}`);
  }

  const out = new Map<number, RawIssueSnapshot>();
  for (const entry of payload) {
    const raw = normalizeSourceIssue(entry as GraphIssueNode);
    const number = Number(raw.number || 0);
    if (!Number.isInteger(number) || number <= 0) continue;
    out.set(number, {
      number,
      title: String(raw.title || "").trim(),
      body: String(raw.body || ""),
      html_url: String(raw.html_url || raw.url || "").trim(),
    });
  }
  return out;
}

function fetchRawIssueSnapshot(repository: string, issueNumber: number): RawIssueSnapshot {
  const endpoint = `repos/${repository}/issues/${issueNumber}`;
  const payload = parseJson(runGh(["api", endpoint]), `gh api ${endpoint}`);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    fail(`gh api ${endpoint} returned invalid issue payload`);
  }
  const item = payload as Record<string, unknown>;
  const number = Number(item.number || 0);
  if (!Number.isInteger(number) || number <= 0) {
    fail(`gh api ${endpoint} returned invalid issue number`);
  }
  return {
    number,
    title: String(item.title || "").trim(),
    body: String(item.body || ""),
    html_url: String(item.html_url || "").trim(),
  };
}

function loadRawSnapshots(
  repository: string,
  issues: TaskIssue[],
  sourcePath: string
): Map<number, RawIssueSnapshot> {
  if (sourcePath) {
    return parseRawIssueSnapshotsFromFile(sourcePath);
  }

  const out = new Map<number, RawIssueSnapshot>();
  for (const issue of issues) {
    out.set(issue.number, fetchRawIssueSnapshot(repository, issue.number));
  }
  return out;
}

function describeNextAction(status: TaskIssueSoTBackfillStatus): string {
  switch (status) {
    case "certified":
      return "No migration action required";
    case "normalization_only":
      return "Normalize the canonical issue title/body with task:backfill-issue-sot -- --apply";
    case "manual_review":
      return "Manual issue review is required before task issue SoT can certify";
  }
}

function analyzeTaskIssueSourceOfTruth(input: {
  issue: TaskIssue;
  title: string;
  body: string;
}): TaskIssueSoTBackfillAnalysis {
  const audit = auditTaskIssueSourceOfTruth(input);
  if (audit.errors.length > 0) {
    return {
      issue_number: input.issue.number,
      task_id: audit.task_id,
      title: input.title,
      status: "manual_review",
      can_apply: false,
      errors: audit.errors,
      mismatches: [],
      next_action: describeNextAction("manual_review"),
      normalized_title: "",
      normalized_body: "",
    };
  }

  const status: TaskIssueSoTBackfillStatus =
    audit.mismatches.length === 0 ? "certified" : "normalization_only";
  return {
    issue_number: input.issue.number,
    task_id: audit.task_id,
    title: input.title,
    status,
    can_apply: status === "normalization_only" && audit.can_apply,
    errors: [],
    mismatches: audit.mismatches,
    next_action: describeNextAction(status),
    normalized_title: audit.normalized_title,
    normalized_body: audit.normalized_body,
  };
}

function collectAnalyses(
  repository: string,
  issues: TaskIssue[],
  sourcePath: string
): TaskIssueSoTBackfillAnalysis[] {
  const rawSnapshots = loadRawSnapshots(repository, issues, sourcePath);
  return issues.map((issue) => {
    const raw = rawSnapshots.get(issue.number);
    if (!raw) {
      return {
        issue_number: issue.number,
        task_id: issue.metadata.task_id,
        title: issue.title,
        status: "manual_review",
        can_apply: false,
        errors: [`raw GitHub issue snapshot is missing for #${issue.number}`],
        mismatches: [],
        next_action: describeNextAction("manual_review"),
        normalized_title: "",
        normalized_body: "",
      };
    }
    return analyzeTaskIssueSourceOfTruth({
      issue,
      title: raw.title,
      body: raw.body,
    });
  });
}

function collectTaskIssueSoTBackfillReport(
  analyses: TaskIssueSoTBackfillAnalysis[]
): TaskIssueSoTBackfillReport {
  const certified = analyses.filter((entry) => entry.status === "certified");
  const normalizationOnly = analyses.filter((entry) => entry.status === "normalization_only");
  const manualReview = analyses.filter((entry) => entry.status === "manual_review");
  return {
    open_task_count: analyses.length,
    certified_count: certified.length,
    normalization_only_count: normalizationOnly.length,
    manual_review_count: manualReview.length,
    failing_count: normalizationOnly.length + manualReview.length,
    issues: analyses,
  };
}

function createTempBodyFile(content: string): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "task-issue-sot-backfill-"));
  const file = path.join(dir, "body.md");
  writeFileSync(file, content, "utf8");
  return {
    file,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function applyNormalization(repository: string, analysis: TaskIssueSoTBackfillAnalysis): void {
  if (!analysis.can_apply) {
    fail(`issue #${analysis.issue_number} (${analysis.task_id}) is not auto-normalizable`);
  }

  const temp = createTempBodyFile(`${analysis.normalized_body}\n`);
  try {
    runGh([
      "issue",
      "edit",
      String(analysis.issue_number),
      "--repo",
      repository,
      "--title",
      analysis.normalized_title,
      "--body-file",
      temp.file,
    ]);
  } finally {
    temp.cleanup();
  }

  const reloaded = fetchRawIssueSnapshot(repository, analysis.issue_number);
  const bodyMatches = reloaded.body.replace(/\r\n/g, "\n").trim() === analysis.normalized_body;
  const titleMatches = reloaded.title.trim() === analysis.normalized_title.trim();
  if (!titleMatches || !bodyMatches) {
    fail(
      `backfill-task-issue-sot read-after-write verification failed for issue #${analysis.issue_number} (${analysis.task_id})`
    );
  }
}

function printSummary(
  report: TaskIssueSoTBackfillReport,
  selectedIssueNumbers: number[],
  appliedIssueNumbers: number[]
): void {
  const lines = [
    `task issue sot backfill | open=${report.open_task_count} | certified=${report.certified_count} | normalization_only=${report.normalization_only_count} | manual_review=${report.manual_review_count}`,
    selectedIssueNumbers.length > 0
      ? `- selected issues: ${selectedIssueNumbers.join(", ")}`
      : "- selected issues: all open tasks",
    appliedIssueNumbers.length > 0
      ? `- applied normalization: ${appliedIssueNumbers.join(", ")}`
      : "- applied normalization: none",
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  const initialLoaded = await loadTaskIssues({
    repository: cli.repository,
    sourcePath: cli.sourcePath || undefined,
    state: "open",
    issueNumbers: cli.issueNumbers,
  });
  const initialIssues = selectOpenIssues(initialLoaded.issues, cli.issueNumbers);
  const appliedIssueNumbers: number[] = [];

  let analyses = collectAnalyses(cli.repository, initialIssues, cli.sourcePath);
  if (cli.apply) {
    const normalizationTargets = analyses.filter((entry) => entry.status === "normalization_only");
    for (const entry of normalizationTargets) {
      applyNormalization(cli.repository, entry);
      appliedIssueNumbers.push(entry.issue_number);
    }

    const reloaded = await loadTaskIssues({
      repository: cli.repository,
      state: "open",
      issueNumbers: cli.issueNumbers,
    });
    const liveIssues = selectOpenIssues(reloaded.issues, cli.issueNumbers);
    analyses = collectAnalyses(cli.repository, liveIssues, "");
  }

  const report = collectTaskIssueSoTBackfillReport(analyses);
  const payload: OutputPayload = {
    generated_at: nowIsoUtc(),
    repository: cli.repository,
    apply: cli.apply,
    selected_issue_numbers: cli.issueNumbers,
    applied_issue_numbers: appliedIssueNumbers,
    ...report,
  };

  writeOutput(cli.outputPath, payload);
  printSummary(report, cli.issueNumbers, appliedIssueNumbers);

  if (report.failing_count > 0) {
    for (const issue of report.issues.filter((entry) => entry.status !== "certified")) {
      for (const detail of [...issue.errors, ...issue.mismatches]) {
        process.stderr.write(`issue #${issue.issue_number} (${issue.task_id}): ${detail}\n`);
      }
      process.stderr.write(
        `issue #${issue.issue_number} (${issue.task_id}): next action: ${issue.next_action}\n`
      );
    }
    process.exit(1);
  }
}

main().catch((error) => {
  process.stderr.write(`backfill-task-issue-sot failed: ${(error as Error).message}\n`);
  process.exit(1);
});
