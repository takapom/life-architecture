#!/usr/bin/env bun

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Command } from "commander";

import { fail, parseJson, runGh, writeOutput } from "../../adapters/cli";
import {
  loadTaskIssues,
  normalizeSourceIssue,
  resolveRepository,
} from "../../core/task-governance";
import {
  analyzeTaskSizingBackfill,
  buildTaskSizingBackfillLinkedChildTaskCountMap,
  collectTaskSizingBackfillReport,
  type TaskSizingBackfillAnalysis,
  type TaskSizingBackfillReport,
} from "../../core/task-governance-backfill";
import type { GraphIssueNode, TaskIssue } from "../../core/task-governance-types";

type Cli = {
  repository: string;
  sourcePath: string;
  outputPath: string;
  apply: boolean;
  mixedGovernanceDocScopeOnly: boolean;
  issueNumbers: number[];
};

type RawIssueSnapshot = {
  number: number;
  title: string;
  body: string;
  state: string;
  html_url: string;
};

type OutputPayload = TaskSizingBackfillReport & {
  audit_mode: "all-open-tasks" | "mixed-governance-doc-scope";
  generated_at: string;
  repository: string;
  apply: boolean;
  scanned_open_task_count: number;
  selected_issue_numbers: number[];
  applied_issue_numbers: number[];
};

const GOVERNANCE_DOC_MIX_ERROR_FRAGMENT = "mix governance/docs scope";

function formatTaskIssueRef(issueNumber: number, taskId: string): string {
  const normalizedTaskId = String(taskId || "").trim();
  return normalizedTaskId ? `issue #${issueNumber} (${normalizedTaskId})` : `issue #${issueNumber}`;
}

function formatIssueDetail(issueRef: string, issueNumber: number, detail: string): string {
  const normalizedDetail = String(detail || "").trim();
  if (!normalizedDetail) {
    return issueRef;
  }
  if (
    normalizedDetail.startsWith(`${issueRef}:`) ||
    normalizedDetail.startsWith(`issue #${issueNumber}:`) ||
    normalizedDetail.startsWith(`issue #${issueNumber} (`)
  ) {
    return normalizedDetail;
  }
  return `${issueRef}: ${normalizedDetail}`;
}

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
    .name("backfill-task-sizing")
    .description("Report or normalize open task issues against the canonical task sizing contract")
    .requiredOption("--repository <slug>", "Target repository <owner/repo>")
    .option("--source <path>", "Offline issue JSON source (report-only)")
    .option("--output <path>", "Write JSON report to a file")
    .option(
      "--mixed-governance-doc-scope",
      "Audit only open tasks that still mix governance/docs scope with implementation owner scope",
      false
    )
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
    .parse(["node", "backfill-task-sizing", ...argv]);

  const opts = program.opts<{
    repository: string;
    source?: string;
    output?: string;
    apply: boolean;
    mixedGovernanceDocScope: boolean;
    issueNumber: number[];
  }>();
  const repositoryRef = resolveRepository(opts.repository);
  const sourcePath = String(opts.source || "").trim();
  const apply = Boolean(opts.apply);
  if (apply && sourcePath) {
    fail(
      "--apply does not support --source; fetch live GitHub issues for read-after-write verification"
    );
  }
  if (apply && opts.mixedGovernanceDocScope) {
    fail("--apply cannot be combined with --mixed-governance-doc-scope");
  }

  return {
    repository: `${repositoryRef.owner}/${repositoryRef.repo}`,
    sourcePath,
    outputPath: String(opts.output || "").trim(),
    apply,
    mixedGovernanceDocScopeOnly: Boolean(opts.mixedGovernanceDocScope),
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

export function parseRawIssueSnapshotsFromFile(sourcePath: string): Map<number, RawIssueSnapshot> {
  const payload = parseJson(readFileSync(path.resolve(sourcePath), "utf8"), sourcePath);
  let issues: unknown[] | null = null;
  if (Array.isArray(payload)) {
    issues = payload;
  } else if (
    payload &&
    typeof payload === "object" &&
    Array.isArray((payload as { issues?: unknown[] }).issues)
  ) {
    issues = (payload as { issues: unknown[] }).issues;
  }
  if (!issues) {
    fail(
      `offline issue source must be a JSON array or an object with an issues array: ${sourcePath}`
    );
  }

  const out = new Map<number, RawIssueSnapshot>();
  for (const entry of issues) {
    const raw = normalizeSourceIssue(entry as GraphIssueNode);
    const number = Number(raw.number || 0);
    if (!Number.isInteger(number) || number <= 0) continue;
    out.set(number, {
      number,
      title: String(raw.title || "").trim(),
      body: String(raw.body || ""),
      state: String(raw.state || "open")
        .trim()
        .toLowerCase(),
      html_url: String(raw.html_url || raw.url || "").trim(),
    });
  }
  return out;
}

export function isGovernanceDocMixedScopeAnalysis(
  analysis: Pick<TaskSizingBackfillAnalysis, "task_sizing_errors">
): boolean {
  return analysis.task_sizing_errors.some((error) =>
    String(error || "").includes(GOVERNANCE_DOC_MIX_ERROR_FRAGMENT)
  );
}

export function filterGovernanceDocMixedScopeAnalyses(
  analyses: TaskSizingBackfillAnalysis[]
): TaskSizingBackfillAnalysis[] {
  return analyses.filter((analysis) => isGovernanceDocMixedScopeAnalysis(analysis));
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
    state: String(item.state || "open")
      .trim()
      .toLowerCase(),
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

function collectAnalyses(
  repository: string,
  issues: TaskIssue[],
  sourcePath: string
): TaskSizingBackfillAnalysis[] {
  const rawSnapshots = loadRawSnapshots(repository, issues, sourcePath);
  const linkedChildTaskCountByParent = buildTaskSizingBackfillLinkedChildTaskCountMap(issues);
  return issues.map((issue) => {
    const raw = rawSnapshots.get(issue.number);
    if (!raw) {
      return {
        issue_number: issue.number,
        task_id: issue.metadata.task_id,
        title: issue.title,
        status: "manual_review",
        can_apply: false,
        task_sizing_errors: [],
        spec_build_errors: [`raw GitHub issue snapshot is missing for #${issue.number}`],
        normalization_mismatches: [],
        next_action: "Manual issue review is required before task sizing can certify",
        normalized_title: "",
        normalized_body: "",
      };
    }
    return analyzeTaskSizingBackfill({
      issue,
      title: raw.title,
      body: raw.body,
      linkedChildTaskCount: Math.max(
        issue.graph.subIssues.length,
        linkedChildTaskCountByParent.get(issue.number) ?? 0
      ),
    });
  });
}

function createTempBodyFile(content: string): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "task-sizing-backfill-"));
  const file = path.join(dir, "body.md");
  writeFileSync(file, content, "utf8");
  return {
    file,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function applyNormalization(repository: string, analysis: TaskSizingBackfillAnalysis): void {
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
      `backfill-task-sizing read-after-write verification failed for issue #${analysis.issue_number} (${analysis.task_id})`
    );
  }
}

function printSummary(
  auditMode: OutputPayload["audit_mode"],
  scannedOpenTaskCount: number,
  report: TaskSizingBackfillReport,
  selectedIssueNumbers: number[],
  appliedIssueNumbers: number[]
): void {
  const lines = [
    auditMode === "mixed-governance-doc-scope"
      ? `task sizing mixed-scope audit | scanned_open=${scannedOpenTaskCount} | mixed_scope=${report.open_task_count} | split_required=${report.split_required_count} | manual_review=${report.manual_review_count}`
      : `task sizing backfill | open=${report.open_task_count} | certified=${report.certified_count} | normalization_only=${report.normalization_only_count} | split_required=${report.split_required_count} | manual_review=${report.manual_review_count}`,
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
  const scannedOpenTaskCount = analyses.length;
  if (cli.mixedGovernanceDocScopeOnly) {
    analyses = filterGovernanceDocMixedScopeAnalyses(analyses);
  }

  const report = collectTaskSizingBackfillReport(analyses);
  const payload: OutputPayload = {
    audit_mode: cli.mixedGovernanceDocScopeOnly ? "mixed-governance-doc-scope" : "all-open-tasks",
    generated_at: nowIsoUtc(),
    repository: cli.repository,
    apply: cli.apply,
    scanned_open_task_count: scannedOpenTaskCount,
    selected_issue_numbers: cli.issueNumbers,
    applied_issue_numbers: appliedIssueNumbers,
    ...report,
  };

  writeOutput(cli.outputPath, payload);
  printSummary(
    payload.audit_mode,
    scannedOpenTaskCount,
    report,
    cli.issueNumbers,
    appliedIssueNumbers
  );

  if (report.failing_count > 0) {
    for (const issue of report.issues.filter((entry) => entry.status !== "certified")) {
      const details = [
        ...issue.task_sizing_errors,
        ...issue.spec_build_errors,
        ...issue.normalization_mismatches,
      ];
      const issueRef = formatTaskIssueRef(issue.issue_number, issue.task_id);
      for (const detail of details) {
        process.stderr.write(`${formatIssueDetail(issueRef, issue.issue_number, detail)}\n`);
      }
      if (cli.mixedGovernanceDocScopeOnly) {
        process.stderr.write(
          `${issueRef}: split or normalize this broad task under the refined lane model before execution continues\n`
        );
      }
      process.stderr.write(`${issueRef}: next action: ${issue.next_action}\n`);
    }
    process.exit(1);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`backfill-task-sizing failed: ${(error as Error).message}\n`);
    process.exit(1);
  });
}
