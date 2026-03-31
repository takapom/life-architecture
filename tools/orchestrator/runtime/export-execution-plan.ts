#!/usr/bin/env bun

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { Command } from "commander";
import {
  currentGitBranch,
  detectRepositoryFromOrigin,
  extractTaskIdFromBranch,
  hasActiveForeignClaim,
  isTaskIssueSnapshotCurrent,
  loadTaskIssues,
  readTaskIssueSnapshot,
  sortIssuesForExecutionPlan,
  type TaskIssue,
  validateIssueGraph,
} from "../../core/task-governance";
import {
  buildExecutionPlanTaskScope,
  type ExecutionPlan,
  type ExecutionPlanNode,
  validateExecutionPlan,
} from "./execution-plan-contract";

export type { ExecutionPlan, ExecutionPlanNode } from "./execution-plan-contract";

type Cli = {
  sourcePath: string;
  outputPath: string;
  repository: string;
  baseBranch: string;
  maxWorkers: number;
  issueNumbers: number[];
};

const repoRoot = path.resolve(import.meta.dir, "../../..");

function parseCli(argv: string[]): Cli {
  const program = new Command()
    .name("export-execution-plan")
    .description("Export actionable task issues as an execution plan JSON for orchestration")
    .option(
      "--repository <owner/repo>",
      "Target repository",
      Bun.env.ISSUE_REPOSITORY || Bun.env.ISSUE_DAG_REPOSITORY || ""
    )
    .option(
      "--source <path>",
      "Offline issue source JSON",
      Bun.env.ISSUE_GRAPH_SOURCE || Bun.env.ISSUE_DAG_SOURCE || ""
    )
    .option(
      "--issue-number <n>",
      "Restrict the execution plan to specific canonical task issue numbers (repeatable)",
      (value: string, previous: number[]) => {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          throw new Error("--issue-number must be a positive integer");
        }
        return [...previous, parsed];
      },
      [] as number[]
    )
    .option("--output <path>", "Output path (default: stdout)")
    .option(
      "--base-branch <name>",
      "Base branch",
      Bun.env.ISSUE_GRAPH_BASE_BRANCH || Bun.env.ISSUE_DAG_BASE_BRANCH || "main"
    )
    .option(
      "--max-workers <n>",
      "Max workers",
      Bun.env.ISSUE_GRAPH_MAX_WORKERS || Bun.env.ISSUE_DAG_MAX_WORKERS || "4"
    )
    .parse(["node", "export-execution-plan", ...argv]);

  const opts = program.opts<{
    repository: string;
    source: string;
    issueNumber: number[];
    output?: string;
    baseBranch: string;
    maxWorkers: string;
  }>();

  const repository = String(opts.repository || "").trim() || detectRepositoryFromOrigin(repoRoot);
  if (!repository) {
    throw new Error("--repository is required (set --repository or ISSUE_REPOSITORY)");
  }

  const maxWorkers = Number(opts.maxWorkers);
  return {
    sourcePath: opts.source,
    outputPath: opts.output || "",
    repository,
    baseBranch: opts.baseBranch,
    maxWorkers: Number.isFinite(maxWorkers) && maxWorkers > 0 ? Math.trunc(maxWorkers) : 4,
    issueNumbers: [
      ...new Set(
        [
          ...(opts.issueNumber || []),
          ...((opts.issueNumber || []).length === 0
            ? resolveImplicitIssueNumbersFromTaskBranch({
                repository,
                repoRoot,
              })
            : []),
        ].filter((value) => value > 0)
      ),
    ],
  };
}

function toSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function toBranchName(issue: TaskIssue): string {
  const task = issue.metadata.task_id.toLowerCase();
  const titleSlug = toSlug(issue.title);
  return titleSlug ? `task/${task}-${titleSlug}` : `task/${task}`;
}

function toIssueUrl(issue: TaskIssue, repository: { owner: string; repo: string }): string {
  const normalized = String(issue.htmlUrl || "").trim();
  if (/^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/i.test(normalized)) {
    return normalized;
  }
  return `https://github.com/${repository.owner}/${repository.repo}/issues/${issue.number}`;
}

function normalizeIssueSummary(issue: TaskIssue): string {
  const taskIdPrefix = `${issue.metadata.task_id}:`;
  const title = issue.title.trim();
  if (!title.toLowerCase().startsWith(taskIdPrefix.toLowerCase())) {
    return `${issue.metadata.task_id}: ${title}`;
  }
  const suffix = title.slice(taskIdPrefix.length).trim();
  return `${issue.metadata.task_id}: ${suffix || title}`;
}

function toSourceItem(
  issue: TaskIssue,
  repository: { owner: string; repo: string },
  verdict: string
) {
  const parentIssueNumber = Number(issue.graph.parent || 0);
  const sourceItem = {
    id: issue.metadata.task_id,
    verdict,
    summary: normalizeIssueSummary(issue),
    github_issue: toIssueUrl(issue, repository),
  };
  if (Number.isInteger(parentIssueNumber) && parentIssueNumber > 0) {
    return {
      ...sourceItem,
      parent_issue_number: parentIssueNumber,
      parent_issue_url: `https://github.com/${repository.owner}/${repository.repo}/issues/${parentIssueNumber}`,
    };
  }
  return sourceItem;
}

function nativeIssueLinkDeps(issue: TaskIssue, actionableIds: Set<string>): string[] {
  return issue.metadata.deps.filter((dep) => actionableIds.has(dep));
}

export function resolveImplicitIssueNumbersFromTaskBranch(options: {
  repository: string;
  repoRoot: string;
  branch?: string;
  readSnapshot?: typeof readTaskIssueSnapshot;
}): number[] {
  try {
    const branch = options.branch || currentGitBranch(options.repoRoot);
    const taskId = extractTaskIdFromBranch(branch);
    if (!taskId) return [];
    const snapshot = (options.readSnapshot || readTaskIssueSnapshot)(options.repoRoot, branch);
    if (
      !isTaskIssueSnapshotCurrent(snapshot, {
        repository: options.repository,
        branch,
        taskId,
      })
    ) {
      return [];
    }
    return [snapshot.issue_number];
  } catch {
    return [];
  }
}

export function isActionableExecutionPlanIssue(issue: TaskIssue, sessionId = ""): boolean {
  if (issue.state !== "open") return false;
  if (issue.metadata.status !== "ready" && issue.metadata.status !== "in progress") {
    return false;
  }
  return !hasActiveForeignClaim(issue.metadata, { sessionId });
}

const EXECUTION_COMMAND_BOUNDARY_NOTE = [
  "Run only the commands explicitly listed under `Tests`, `Acceptance Command Gate`, and",
  "`Required Worktree Gate` in this task prompt.",
  "Do not add extra global gates (for example `bun run ci:strict` / `bun run ci:fast`) unless",
  "they are explicitly listed.",
  "If unrelated pre-existing failures are observed outside listed commands, mention them in",
  "`tests[].notes` but do not block task completion on that basis.",
].join(" ");

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return 0;
  return parsed;
}

function resolveProgressIssueNumber(issues: TaskIssue[]): number {
  const fromEnv = parsePositiveInteger(
    String(
      Bun.env.ISSUE_GRAPH_PROGRESS_ISSUE_NUMBER || Bun.env.ISSUE_DAG_PROGRESS_ISSUE_NUMBER || ""
    ).trim()
  );
  if (fromEnv > 0) return fromEnv;

  const parents = [
    ...new Set(
      issues
        .map((issue) => Number(issue.graph.parent || 0))
        .filter((num) => Number.isInteger(num) && num > 0)
    ),
  ];
  return parents.length === 1 ? parents[0] : 0;
}

export function buildExecutionPlan(input: {
  actionable: TaskIssue[];
  pending: TaskIssue[];
  deferredItems: Array<{ id: string; reason: string }>;
  repositoryRef: { owner: string; repo: string };
  baseBranch: string;
  maxWorkers: number;
  progressIssueNumber: number;
  progressIssueUrl: string;
}): ExecutionPlan {
  const {
    actionable,
    pending,
    deferredItems,
    repositoryRef,
    baseBranch,
    maxWorkers,
    progressIssueNumber,
    progressIssueUrl,
  } = input;

  const actionableIds = new Set(actionable.map((issue) => issue.metadata.task_id));
  const sourceItems = [
    ...actionable.map((issue) => toSourceItem(issue, repositoryRef, "valid")),
    ...pending.map((issue) => toSourceItem(issue, repositoryRef, "pending")),
  ];
  const issueMap = Object.fromEntries(
    sourceItems
      .map((item) => [item.id, item.github_issue] as const)
      .sort(([left], [right]) => left.localeCompare(right))
  );
  const nodes: ExecutionPlanNode[] = actionable.map((issue) => {
    if (issue.metadata.commit_units.length === 0) {
      throw new Error(`execution-plan export requires commit_units for ${issue.metadata.task_id}`);
    }
    return {
      id: issue.metadata.task_id,
      issue_node_id: issue.id,
      branch: toBranchName(issue),
      priority: issue.metadata.priority,
      deps: nativeIssueLinkDeps(issue, actionableIds),
      github_issue: toIssueUrl(issue, repositoryRef),
      scope: issue.metadata.allowed_files.join("\n"),
      allowed_files: [...issue.metadata.allowed_files],
      commit_units: [...issue.metadata.commit_units],
      non_goals: [...issue.metadata.non_goals],
      acceptance_checks: [...issue.metadata.acceptance_checks],
      tests: [...issue.metadata.tests],
      covers: [issue.metadata.task_id],
      instructions: EXECUTION_COMMAND_BOUNDARY_NOTE,
      task_scope: buildExecutionPlanTaskScope(
        issue.metadata.allowed_files,
        issue.metadata.commit_units,
        {
          admissionMode: issue.metadata.admission_mode,
          globalInvariant: issue.metadata.global_invariant,
          unfreezeCondition: issue.metadata.unfreeze_condition,
        }
      ),
    };
  });

  return {
    base_branch: baseBranch,
    max_workers: maxWorkers,
    merge_mode: "remote-pr",
    merge_queue: false,
    cleanup: true,
    queue_strategy: "dag_priority",
    require_passing_tests: true,
    require_traceability: true,
    require_acceptance_checks: true,
    issue_tracking: {
      strategy: "remote-github-sot",
      repository: `${repositoryRef.owner}/${repositoryRef.repo}`,
      node_issue_mode: "per-node",
      progress_issue_number: progressIssueNumber,
      progress_issue_url: progressIssueUrl,
    },
    source_items: sourceItems,
    issue_map: issueMap,
    deferred_items: deferredItems,
    nodes,
  };
}

export function compileExecutionPlan(input: {
  issues: TaskIssue[];
  repositoryRef: { owner: string; repo: string };
  baseBranch: string;
  maxWorkers: number;
  sessionId?: string;
  selectedIssueNumbers?: number[];
}): ExecutionPlan {
  const selectedIssueNumbers = [
    ...new Set((input.selectedIssueNumbers || []).filter((value) => value > 0)),
  ];
  const selectedIssues =
    selectedIssueNumbers.length > 0
      ? input.issues.filter((issue) => selectedIssueNumbers.includes(issue.number))
      : [...input.issues];
  const actionable = selectedIssues.filter((issue) =>
    isActionableExecutionPlanIssue(issue, input.sessionId || "")
  );
  const pending = selectedIssues
    .filter(
      (issue) =>
        issue.state === "open" &&
        (issue.metadata.status === "ready" || issue.metadata.status === "in progress") &&
        !actionable.includes(issue)
    )
    .filter((issue) => hasActiveForeignClaim(issue.metadata, { sessionId: input.sessionId || "" }));
  const deferredItems = pending.map((issue) => ({
    id: issue.metadata.task_id,
    reason: `active_claim_lease owner=${issue.metadata.claimed_by || "(unknown)"} lease_expires_at=${issue.metadata.lease_expires_at || "(missing)"}`,
  }));
  const progressIssueNumber = resolveProgressIssueNumber(actionable);
  const progressIssueUrl =
    progressIssueNumber > 0
      ? `https://github.com/${input.repositoryRef.owner}/${input.repositoryRef.repo}/issues/${progressIssueNumber}`
      : "";

  const plan = buildExecutionPlan({
    actionable,
    pending,
    deferredItems,
    repositoryRef: input.repositoryRef,
    baseBranch: input.baseBranch,
    maxWorkers: input.maxWorkers,
    progressIssueNumber,
    progressIssueUrl,
  });
  const errors = validateExecutionPlan(plan);
  if (errors.length > 0) {
    throw new Error(`execution plan contract validation failed:\n- ${errors.join("\n- ")}`);
  }
  return plan;
}

export async function main(argv = Bun.argv.slice(2)): Promise<void> {
  const cli = parseCli(argv);
  const sessionId = String(Bun.env.ORCHESTRATE_SESSION_ID || "")
    .trim()
    .toLowerCase();
  const repositoryRef = (() => {
    const [owner, repo] = cli.repository.split("/");
    if (!owner || !repo) {
      throw new Error(`invalid repository: ${cli.repository}`);
    }
    return { owner, repo };
  })();

  const { issues } = await loadTaskIssues({
    repository: cli.repository,
    sourcePath: cli.sourcePath,
    issueNumbers: cli.issueNumbers,
  });
  const orderedIssues = sortIssuesForExecutionPlan(issues);
  const validation = validateIssueGraph(orderedIssues);
  if (validation.errors.length > 0) {
    throw new Error(
      `cannot export execution plan because issue graph validation failed:\n${validation.errors.join("\n")}`
    );
  }

  const plan = compileExecutionPlan({
    issues: orderedIssues,
    repositoryRef,
    baseBranch: cli.baseBranch,
    maxWorkers: cli.maxWorkers,
    sessionId,
  });

  if (cli.outputPath) {
    const absolute = path.resolve(cli.outputPath);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    process.stdout.write(`${absolute}\n`);
    return;
  }

  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
}

if (import.meta.path === Bun.main) {
  await main();
}
