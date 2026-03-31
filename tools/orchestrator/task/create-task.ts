#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Command } from "commander";

import { fail, type JsonObject, parseJson } from "../../adapters/cli";
import {
  collectTaskIssueReadAfterWriteMismatches,
  collectTaskSizingFindings,
  loadTaskIssueByTaskId,
  loadTaskIssueByTaskIdFromControlPlane,
  normalizeIssueBodyForComparison,
  parseTaskSpec,
  renderIssueBody,
  resolveRepository,
  type TaskSpec,
  tryBuildTaskSpecFromIssueSnapshot,
} from "../../core/task-governance";
import type { TaskMetadata } from "../../core/task-governance-types";

type Cli = {
  repository: string;
  standalone: boolean;
  issueNumber: number;
  parentIssue: string;
  parentTitle: string;
  parentBody: string;
  parentLabels: string[];
  inputPath: string;
  outputPath: string;
  dryRun: boolean;
};

type UpsertResult = {
  action: string;
  issue_number: number;
  issue_url: string;
  task_id: string;
};

type ParentIssueResult = {
  issue_number: number;
  issue_url: string;
  title: string;
  labels: string[];
};
type ReadAfterWriteRemoteIssue = {
  number: number;
  title: string;
  body: string;
  state: string;
};
const GH_ISSUE_URL_RE = /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/(\d+)\/?$/i;

function parsePositiveInteger(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    fail(`${field} must be a positive integer`);
  }
  return parsed;
}

function resolveBody(body: string, bodyFile: string, required: boolean): string {
  const inline = String(body || "").trim();
  const filePath = String(bodyFile || "").trim();
  if (inline && filePath) {
    fail("use either --parent-body or --parent-body-file, not both");
  }
  if (inline) return inline;
  if (filePath) {
    return readFileSync(path.resolve(filePath), "utf8").trim();
  }
  if (required) {
    fail("--parent-body or --parent-body-file is required when creating a parent issue");
  }
  return "";
}

function collectLabels(value: string, previous: string[]): string[] {
  const normalized = String(value || "").trim();
  if (!normalized) return previous;
  return [...previous, normalized];
}

function parseCli(argv: string[]): Cli {
  const program = new Command()
    .name("create-task")
    .description("Create or normalize a canonical issue-only task issue")
    .requiredOption("--repository <owner/repo>", "Target repository")
    .option(
      "--standalone",
      "Create a new standalone task issue explicitly (required when not reusing or splitting)"
    )
    .option("--issue-number <n>", "Normalize an existing task issue in place", (v: string) =>
      parsePositiveInteger(v, "--issue-number")
    )
    .option(
      "--parent-issue <ref>",
      "Existing parent issue number or URL (only for explicit grouped decomposition)"
    )
    .option(
      "--parent-title <title>",
      "Create a new parent issue for explicit grouped decomposition"
    )
    .option("--parent-body <text>", "Parent issue body")
    .option("--parent-body-file <path>", "Parent issue body file")
    .option(
      "--parent-label <label>",
      "Parent issue label (repeatable)",
      collectLabels,
      [] as string[]
    )
    .requiredOption("--input <path>", "Task spec JSON path")
    .option("--dry-run", "Plan only (no create/edit)", false)
    .option("--output <path>", "Output JSON path")
    .addHelpText(
      "after",
      [
        "",
        "Task Spec JSON (canonical):",
        "  task_id, summary, background, runtime_invariants, ownership_sot,",
        "  task_type, status, priority, admission_mode, global_invariant,",
        "  unfreeze_condition, allowed_files, acceptance_checks,",
        "  tests, non_goals, forbidden_shortcuts, commit_units, reviewer_outcomes,",
        "  canonical_gap, canonical_gap_owner, canonical_gap_review_date,",
        "  canonical_deferral_reason, canonical_deferral_condition,",
        "  task_sizing_exception, task_sizing_exception_type,",
        "  task_sizing_split_failure, task_sizing_exception_reviewer_attestation,",
        "  acceptance_criteria,",
        "  task_sizing_unsafe_state, task_sizing_affected_invariant,",
        "  task_sizing_atomic_boundary, proof_tests, rca_scope, title(optional)",
        "",
        "Common paths:",
        "  - standalone task: pass --standalone",
        "  - normalize existing issue: pass --issue-number <n>",
        "  - grouped decomposition under existing parent: pass --parent-issue <ref>",
        "  - grouped decomposition with a new parent: pass --parent-title plus --parent-body/--parent-body-file",
      ].join("\n")
    )
    .parse(["node", "create-task", ...argv]);

  const opts = program.opts<{
    repository: string;
    standalone?: boolean;
    issueNumber?: number;
    parentIssue?: string;
    parentTitle?: string;
    parentBody?: string;
    parentBodyFile?: string;
    parentLabel: string[];
    input: string;
    dryRun: boolean;
    output?: string;
  }>();

  const repo = resolveRepository(opts.repository);
  const parentTitle = String(opts.parentTitle || "").trim();
  const parentIssue = String(opts.parentIssue || "").trim();
  const wantsParentCreation =
    parentTitle.length > 0 ||
    String(opts.parentBody || "").trim().length > 0 ||
    String(opts.parentBodyFile || "").trim().length > 0 ||
    (opts.parentLabel || []).some((label) => String(label || "").trim().length > 0);
  if (parentIssue && wantsParentCreation) {
    fail("use either --parent-issue or --parent-title/--parent-body*, not both");
  }
  if (!parentTitle && wantsParentCreation) {
    fail("--parent-title is required when creating a new parent issue");
  }
  const standalone = Boolean(opts.standalone);
  const explicitExistingIssue = Number(opts.issueNumber || 0) > 0;
  const explicitGroupedDecomposition = parentIssue.length > 0 || parentTitle.length > 0;
  if (!standalone && !explicitExistingIssue && !explicitGroupedDecomposition) {
    fail(
      "task:create requires an explicit intake mode: pass --standalone for a new standalone task, --issue-number <n> to normalize an existing issue in place, or --parent-issue/--parent-title for explicit grouped decomposition"
    );
  }
  if (standalone && explicitGroupedDecomposition) {
    fail("--standalone cannot be combined with grouped decomposition flags");
  }
  if (standalone && explicitExistingIssue) {
    fail("--standalone cannot be combined with --issue-number");
  }
  const parentBody = resolveBody(
    String(opts.parentBody || ""),
    String(opts.parentBodyFile || ""),
    parentTitle.length > 0
  );

  return {
    repository: `${repo.owner}/${repo.repo}`,
    standalone,
    issueNumber: Number(opts.issueNumber || 0),
    parentIssue,
    parentTitle,
    parentBody,
    parentLabels: [
      ...new Set((opts.parentLabel || []).map((label) => label.trim()).filter(Boolean)),
    ],
    inputPath: opts.input,
    outputPath: opts.output || "",
    dryRun: opts.dryRun,
  };
}

function parseJsonFile(filePath: string): unknown {
  const absolute = path.resolve(filePath);
  try {
    return JSON.parse(readFileSync(absolute, "utf8")) as unknown;
  } catch (error) {
    fail(`invalid JSON (${filePath}): ${(error as Error).message}`);
  }
}

function ensureObject(value: unknown, field: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${field} must be an object`);
  }
  return value as JsonObject;
}

function buildIssueOnlyReadAfterWriteMetadata(issueState: string): TaskMetadata {
  return {
    task_id: "",
    task_type: "",
    status: issueState === "closed" ? "done" : "backlog",
    run_id: "",
    claimed_by: "",
    lease_expires_at: "",
    priority: 100,
    deps: [],
    allowed_files: [],
    acceptance_checks: [],
    tests: [],
    non_goals: [],
    commit_units: [],
    reviewer_outcomes: [],
    canonical_gap: "",
    canonical_gap_owner: "",
    canonical_gap_review_date: "",
    canonical_deferral_reason: "",
    canonical_deferral_condition: "",
    task_sizing_exception: "",
    task_sizing_exception_type: "",
    task_sizing_split_failure: "",
    task_sizing_exception_reviewer_attestation: "",
    task_sizing_unsafe_state: "",
    task_sizing_affected_invariant: "",
    task_sizing_atomic_boundary: "",
    acceptance_criteria: [],
    rca_scope: "",
  };
}

export function collectIssueOnlyReadAfterWriteMismatches(
  spec: TaskSpec,
  issue: Pick<ReadAfterWriteRemoteIssue, "number" | "title" | "body" | "state">
): string[] {
  const mismatches: string[] = [];
  const rebuilt = tryBuildTaskSpecFromIssueSnapshot({
    title: issue.title,
    body: issue.body,
    metadata: buildIssueOnlyReadAfterWriteMetadata(issue.state),
  });

  if (rebuilt.errors.length > 0 || !rebuilt.spec) {
    mismatches.push(
      `issue-only rebuild failed: ${rebuilt.errors.length > 0 ? rebuilt.errors.join("; ") : "rebuilt task spec is empty"}`
    );
    return mismatches;
  }

  mismatches.push(
    ...collectTaskIssueReadAfterWriteMismatches(spec, {
      number: issue.number,
      title: issue.title,
      state: issue.state === "closed" ? "closed" : "open",
      metadata: rebuilt.spec
        ? {
            ...buildIssueOnlyReadAfterWriteMetadata(issue.state),
            task_id: rebuilt.spec.task_id,
            task_type: rebuilt.spec.task_type,
            status: rebuilt.spec.status,
            priority: rebuilt.spec.priority,
            allowed_files: rebuilt.spec.allowed_files,
            acceptance_checks: rebuilt.spec.acceptance_checks,
            tests: rebuilt.spec.tests,
            non_goals: rebuilt.spec.non_goals,
            commit_units: rebuilt.spec.commit_units,
            reviewer_outcomes: rebuilt.spec.reviewer_outcomes,
            canonical_gap: rebuilt.spec.canonical_gap,
            canonical_gap_owner: rebuilt.spec.canonical_gap_owner,
            canonical_gap_review_date: rebuilt.spec.canonical_gap_review_date,
            canonical_deferral_reason: rebuilt.spec.canonical_deferral_reason,
            canonical_deferral_condition: rebuilt.spec.canonical_deferral_condition,
            task_sizing_exception: rebuilt.spec.task_sizing_exception,
            task_sizing_exception_type: rebuilt.spec.task_sizing_exception_type,
            task_sizing_split_failure: rebuilt.spec.task_sizing_split_failure,
            task_sizing_exception_reviewer_attestation:
              rebuilt.spec.task_sizing_exception_reviewer_attestation,
            task_sizing_unsafe_state: rebuilt.spec.task_sizing_unsafe_state,
            task_sizing_affected_invariant: rebuilt.spec.task_sizing_affected_invariant,
            task_sizing_atomic_boundary: rebuilt.spec.task_sizing_atomic_boundary,
            acceptance_criteria: rebuilt.spec.acceptance_criteria,
            rca_scope: rebuilt.spec.rca_scope,
          }
        : buildIssueOnlyReadAfterWriteMetadata(issue.state),
    })
  );

  if (
    normalizeIssueBodyForComparison(issue.body) !==
    normalizeIssueBodyForComparison(renderIssueBody(spec))
  ) {
    mismatches.push(
      "body mismatch (remote issue body does not match canonical issue-only task render)"
    );
  }
  return mismatches;
}

type TaskIssueReadAfterWriteLoader = typeof loadTaskIssueByTaskId;
type TaskIssueControlPlaneLoader = typeof loadTaskIssueByTaskIdFromControlPlane;

export function readTaskIssueForReadAfterWrite(options: {
  repository: string;
  taskId: string;
  sourcePath?: string;
  liveLoader?: TaskIssueControlPlaneLoader;
  sourceLoader?: TaskIssueReadAfterWriteLoader;
}): Promise<Awaited<ReturnType<TaskIssueReadAfterWriteLoader>>> {
  const sourcePath = String(options.sourcePath || "").trim();
  if (sourcePath) {
    return (options.sourceLoader || loadTaskIssueByTaskId)({
      taskId: options.taskId,
      repository: options.repository,
      sourcePath,
    });
  }
  return (options.liveLoader || loadTaskIssueByTaskIdFromControlPlane)({
    taskId: options.taskId,
    repository: options.repository,
  });
}

async function verifyTaskIssueReadAfterWrite(
  repository: string,
  issueNumber: number,
  spec: TaskSpec
): Promise<void> {
  const sourcePath = String(Bun.env.OMTA_TASK_CREATE_READ_AFTER_WRITE_SOURCE || "").trim();
  if (sourcePath) {
    const loaded = await readTaskIssueForReadAfterWrite({
      taskId: spec.task_id,
      repository,
      sourcePath,
    });
    if (loaded.issue.number !== issueNumber) {
      fail(
        `create-task read-after-write verification failed: expected issue #${issueNumber} for ${spec.task_id}, got #${loaded.issue.number}`
      );
    }
    const mismatches = collectTaskIssueReadAfterWriteMismatches(spec, loaded.issue);
    if (mismatches.length > 0) {
      fail(
        `create-task read-after-write verification failed for issue #${issueNumber} (${spec.task_id}): ${mismatches.join("; ")}`
      );
    }
    return;
  }

  const remoteIssue = fetchReadAfterWriteRemoteIssue(repository, issueNumber);
  const mismatches = collectIssueOnlyReadAfterWriteMismatches(spec, remoteIssue);
  if (mismatches.length > 0) {
    fail(
      `create-task read-after-write verification failed for issue #${issueNumber} (${spec.task_id}): ${mismatches.join("; ")}`
    );
  }
}

function runCapture(command: string, args: string[], cwd: string): string {
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

function parseIssueNumberFromUrl(url: string, field: string): number {
  const matched = String(url || "")
    .trim()
    .match(GH_ISSUE_URL_RE);
  if (!matched) {
    fail(`${field} must be a GitHub issue URL`);
  }
  const number = Number(matched[1] || 0);
  if (!Number.isInteger(number) || number <= 0) {
    fail(`${field} must contain a positive issue number`);
  }
  return number;
}

function fetchReadAfterWriteRemoteIssue(
  repository: string,
  issueNumber: number
): ReadAfterWriteRemoteIssue {
  const stdout = runCapture(
    Bun.env.OMTA_GH_BIN || "gh",
    ["api", `repos/${repository}/issues/${issueNumber}`],
    process.cwd()
  );
  const payload = ensureObject(parseJson(stdout || "{}", "read-after-write remote issue"), "issue");
  return {
    number: Number(payload.number || 0),
    title: String(payload.title || "").trim(),
    body: String(payload.body || ""),
    state: String(payload.state || "")
      .trim()
      .toLowerCase(),
  };
}

function createParentIssue(cli: Cli): ParentIssueResult {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "create-task-parent-"));
  const bodyPath = path.join(tempDir, "parent-body.md");

  try {
    writeFileSync(bodyPath, `${cli.parentBody}\n`, "utf8");
    const args = [
      "issue",
      "create",
      "--repo",
      cli.repository,
      "--title",
      cli.parentTitle,
      "--body-file",
      bodyPath,
    ];
    for (const label of cli.parentLabels) {
      args.push("--label", label);
    }
    const issueUrl = runCapture(Bun.env.OMTA_GH_BIN || "gh", args, process.cwd());
    return {
      issue_number: parseIssueNumberFromUrl(issueUrl, "parent issue url"),
      issue_url: issueUrl,
      title: cli.parentTitle,
      labels: cli.parentLabels,
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function runIssueUpsert(options: {
  repository: string;
  parentIssue?: string;
  issueNumber?: number;
  payloadPath: string;
  dryRun: boolean;
  createOnly: boolean;
}): UpsertResult {
  const issueRuntime = path.resolve(import.meta.dir, "../runtime/issue.ts");
  const args = [
    issueRuntime,
    "upsert-task-issues",
    "--repository",
    options.repository,
    "--input",
    options.payloadPath,
  ];
  if (String(options.parentIssue || "").trim()) {
    args.splice(4, 0, "--parent-issue", String(options.parentIssue).trim());
  }
  if (Number(options.issueNumber || 0) > 0) {
    args.push("--issue-number", String(Number(options.issueNumber || 0)));
  }
  if (options.dryRun) {
    args.push("--dry-run");
  }
  if (options.createOnly) {
    args.push("--create-only");
  }
  const stdout = runCapture(Bun.env.OMTA_BUN_BIN || "bun", args, process.cwd());
  const payload = ensureObject(
    parseJson(stdout || "{}", "issue upsert runtime output"),
    "issue upsert runtime output"
  );
  const results = Array.isArray(payload.results) ? payload.results : [];
  if (results.length !== 1) {
    fail("issue upsert runtime must return exactly one result for create-task");
  }
  const first = ensureObject(results[0], "issue upsert runtime.results[0]");
  return {
    action: String(first.action || "").trim(),
    issue_number: Number(first.issue_number || 0),
    issue_url: String(first.issue_url || "").trim(),
    task_id: String(first.task_id || "").trim(),
  };
}

function writeOutput(outputPath: string, payload: unknown): void {
  if (!outputPath) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  writeFileSync(path.resolve(outputPath), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
  await Promise.resolve();
  const cli = parseCli(process.argv.slice(2));
  const spec = parseTaskSpec(parseJsonFile(cli.inputPath));
  const taskSizingFindings = collectTaskSizingFindings({
    taskId: spec.task_id,
    admissionMode: spec.admission_mode,
    globalInvariant: spec.global_invariant,
    unfreezeCondition: spec.unfreeze_condition,
    allowedFiles: spec.allowed_files,
    commitUnits: spec.commit_units,
    reviewerOutcomes: spec.reviewer_outcomes,
    canonicalGap: spec.canonical_gap,
    canonicalGapOwner: spec.canonical_gap_owner,
    canonicalGapReviewDate: spec.canonical_gap_review_date,
    canonicalDeferralReason: spec.canonical_deferral_reason,
    canonicalDeferralCondition: spec.canonical_deferral_condition,
    taskSizingException: spec.task_sizing_exception,
    taskSizingExceptionType: spec.task_sizing_exception_type,
    taskSizingSplitFailure: spec.task_sizing_split_failure,
    taskSizingExceptionReviewerAttestation: spec.task_sizing_exception_reviewer_attestation,
    taskSizingUnsafeState: spec.task_sizing_unsafe_state,
    taskSizingAffectedInvariant: spec.task_sizing_affected_invariant,
    taskSizingAtomicBoundary: spec.task_sizing_atomic_boundary,
  });
  const { errors: taskSizingErrors, warnings: taskSizingWarnings } = taskSizingFindings;

  const issueBody = renderIssueBody(spec);
  const intakePayload = {
    items: [
      {
        task_id: spec.task_id,
        issue: {
          title: spec.title,
          body: issueBody,
          labels: ["task"],
        },
      },
    ],
  };

  const tempDir = mkdtempSync(path.join(os.tmpdir(), "create-task-"));
  const intakePath = path.join(tempDir, "intake.json");
  try {
    for (const error of taskSizingErrors) {
      process.stderr.write(`${error}\n`);
    }
    for (const warning of taskSizingWarnings) {
      process.stderr.write(`${warning}\n`);
    }
    if (taskSizingErrors.length > 0) {
      fail(taskSizingErrors.join("\n"));
    }

    writeFileSync(intakePath, `${JSON.stringify(intakePayload, null, 2)}\n`, "utf8");
    const explicitExistingIssue = cli.issueNumber > 0;
    const requiresParentCreation = cli.parentTitle.length > 0;

    if (cli.dryRun) {
      const planned = runIssueUpsert({
        repository: cli.repository,
        parentIssue: cli.parentIssue,
        issueNumber: cli.issueNumber,
        payloadPath: intakePath,
        dryRun: true,
        createOnly: !explicitExistingIssue,
      });
      const expectedAction = explicitExistingIssue ? "update_planned" : "create_planned";
      if (planned.action !== expectedAction) {
        fail(`create-task expected ${expectedAction} but got: ${planned.action || "(empty)"}`);
      }
      writeOutput(cli.outputPath, {
        generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        dry_run: true,
        repository: cli.repository,
        task_id: spec.task_id,
        ...(taskSizingWarnings.length > 0 ? { task_sizing_warnings: taskSizingWarnings } : {}),
        ...(cli.parentIssue ? { parent_issue: cli.parentIssue } : {}),
        ...(requiresParentCreation
          ? {
              parent_issue_plan: {
                action: "create_planned",
                title: cli.parentTitle,
                labels: cli.parentLabels,
                body_preview: cli.parentBody,
              },
            }
          : {}),
        issue_plan: planned,
      });
      return;
    }

    let createdParentIssue: ParentIssueResult | null = null;
    let effectiveParentIssue = cli.parentIssue;
    if (requiresParentCreation) {
      createdParentIssue = createParentIssue(cli);
      effectiveParentIssue = createdParentIssue.issue_url;
    }

    let created: UpsertResult;
    try {
      created = runIssueUpsert({
        repository: cli.repository,
        parentIssue: effectiveParentIssue,
        issueNumber: cli.issueNumber,
        payloadPath: intakePath,
        dryRun: false,
        createOnly: !explicitExistingIssue,
      });
    } catch (error) {
      if (createdParentIssue) {
        fail(
          `task issue upsert failed after parent issue creation (#${createdParentIssue.issue_number} ${createdParentIssue.issue_url}): ${(error as Error).message}`
        );
      }
      throw error;
    }
    const expectedAction = explicitExistingIssue ? "updated" : "created";
    if (created.action !== expectedAction) {
      fail(`create-task expected ${expectedAction} action but got: ${created.action || "(empty)"}`);
    }
    if (!created.issue_url || created.issue_number <= 0) {
      fail("create-task failed to resolve task issue URL/number");
    }

    await verifyTaskIssueReadAfterWrite(cli.repository, created.issue_number, spec);

    writeOutput(cli.outputPath, {
      generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      dry_run: false,
      repository: cli.repository,
      task_id: spec.task_id,
      ...(taskSizingWarnings.length > 0 ? { task_sizing_warnings: taskSizingWarnings } : {}),
      issue_number: created.issue_number,
      issue_url: created.issue_url,
      ...(effectiveParentIssue ? { parent_issue: effectiveParentIssue } : {}),
      ...(createdParentIssue ? { created_parent_issue: createdParentIssue } : {}),
      action: created.action,
      read_after_write_verified: true,
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`create-task failed: ${(error as Error).message}\n`);
    process.exit(1);
  });
}
