#!/usr/bin/env bun

import path from "node:path";

import { Command } from "commander";
import { hasRecentRelevantWorktreeActivity } from "../../../platform/dev/worktree/worktree-activity";
import { writeOutput } from "../../adapters/cli";
import {
  type BoundedTaskIssueOverlayRequest,
  loadTaskIssuesFromSourceNodes,
} from "../../adapters/issue-graph-fetch";
import { listCanonicalTaskWorktrees } from "../../adapters/worktree";
import {
  buildTaskScopeManifestFromTaskIssue,
  collectManifestConflicts,
  extractTaskIdFromBranch,
  normalizeTaskId,
  readTaskIssueSnapshot,
} from "../../core/task-governance";
import { collectTaskSizingCertificationReport } from "../../core/task-governance-certification";
import { runRepoctlControlPlaneTaskIssueBundle } from "../../repoctl/runtime";

type Cli = {
  branch: string;
  includeOverlappingLiveTasks: boolean;
  repository: string;
  repoRoot: string;
  sourcePath: string;
  outputPath: string;
  taskId: string;
};

type OutputPayload = {
  generated_at: string;
  repository: string;
  open_task_count: number;
  certified_task_count: number;
  failing_task_count: number;
  failing_tasks: Array<{
    issue_number: number;
    task_id: string;
    title: string;
    errors: string[];
  }>;
};

type ResolveScopedTaskIdsDeps = {
  buildTaskScopeManifestFromTaskIssue?: typeof buildTaskScopeManifestFromTaskIssue;
  collectManifestConflicts?: typeof collectManifestConflicts;
  extractTaskIdFromBranch?: typeof extractTaskIdFromBranch;
  hasRecentRelevantWorktreeActivity?: typeof hasRecentRelevantWorktreeActivity;
  listCanonicalTaskWorktrees?: typeof listCanonicalTaskWorktrees;
};

type LoadTaskIssuesForCertificationDeps = {
  extractTaskIdFromBranch?: typeof extractTaskIdFromBranch;
  hasRecentRelevantWorktreeActivity?: typeof hasRecentRelevantWorktreeActivity;
  loadTaskIssuesFromSourceNodes?: typeof loadTaskIssuesFromSourceNodes;
  listCanonicalTaskWorktrees?: typeof listCanonicalTaskWorktrees;
  normalizeTaskId?: typeof normalizeTaskId;
  readTaskIssueSnapshot?: typeof readTaskIssueSnapshot;
  runRepoctlControlPlaneTaskIssueBundle?: typeof runRepoctlControlPlaneTaskIssueBundle;
};

function formatTaskRef(issueNumber: number, taskId: string): string {
  const normalizedTaskId = String(taskId || "").trim();
  return normalizedTaskId ? `${normalizedTaskId} (#${issueNumber})` : `#${issueNumber}`;
}

function nowIsoUtc(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function resolveBoundedTaskIssueOverlayRequests(
  cli: Pick<Cli, "branch" | "includeOverlappingLiveTasks" | "repoRoot" | "taskId">,
  deps: Pick<
    LoadTaskIssuesForCertificationDeps,
    | "extractTaskIdFromBranch"
    | "hasRecentRelevantWorktreeActivity"
    | "listCanonicalTaskWorktrees"
    | "normalizeTaskId"
    | "readTaskIssueSnapshot"
  > = {}
): BoundedTaskIssueOverlayRequest[] {
  const listWorktrees = deps.listCanonicalTaskWorktrees || listCanonicalTaskWorktrees;
  const hasRecentActivity =
    deps.hasRecentRelevantWorktreeActivity || hasRecentRelevantWorktreeActivity;
  const extractTaskId = deps.extractTaskIdFromBranch || extractTaskIdFromBranch;
  const normalizeTaskIdValue = deps.normalizeTaskId || normalizeTaskId;
  const readSnapshot = deps.readTaskIssueSnapshot || readTaskIssueSnapshot;
  const repoRoot = cli.repoRoot ? path.resolve(cli.repoRoot) : "";
  const overlayRequests = new Map<string, BoundedTaskIssueOverlayRequest>();

  const recordRequest = (taskIdValue: string, branchValue = ""): void => {
    const taskId = normalizeTaskIdValue(taskIdValue);
    if (!taskId || overlayRequests.has(taskId)) {
      return;
    }

    const issueSnapshot =
      repoRoot && branchValue ? readSnapshot(repoRoot, branchValue.trim()) : undefined;
    const issueNumber = Number(issueSnapshot?.issue_number || 0);
    overlayRequests.set(taskId, {
      ...(Number.isInteger(issueNumber) && issueNumber > 0 ? { issueNumber } : {}),
      taskId,
    });
  };

  recordRequest(cli.taskId, cli.branch);
  if (cli.includeOverlappingLiveTasks && repoRoot) {
    for (const worktree of listWorktrees(repoRoot)) {
      if (!hasRecentActivity(worktree.path)) {
        continue;
      }
      recordRequest(extractTaskId(worktree.branch) || "", worktree.branch);
    }
  }

  return [...overlayRequests.values()].sort((left, right) =>
    left.taskId.localeCompare(right.taskId)
  );
}

export function loadTaskIssuesForCertification(
  cli: Cli,
  deps: LoadTaskIssuesForCertificationDeps = {}
): ReturnType<typeof loadTaskIssuesFromSourceNodes>["issues"] {
  const loadIssuesFromNodes = deps.loadTaskIssuesFromSourceNodes || loadTaskIssuesFromSourceNodes;
  const loadBundle =
    deps.runRepoctlControlPlaneTaskIssueBundle || runRepoctlControlPlaneTaskIssueBundle;
  const bundle = loadBundle({
    cwd: cli.repoRoot ? path.resolve(cli.repoRoot) : undefined,
    overlayRequests:
      cli.sourcePath && cli.taskId ? resolveBoundedTaskIssueOverlayRequests(cli, deps) : undefined,
    repository: cli.repository,
    sourcePath: cli.sourcePath || undefined,
    state: "open",
  });
  return loadIssuesFromNodes(
    bundle.issues as Parameters<typeof loadTaskIssuesFromSourceNodes>[0],
    cli.repository,
    {
      state: "open",
    }
  ).issues;
}

function parseCli(argv: string[]): Cli {
  const program = new Command()
    .name("certify-task-sizing")
    .description("Fail closed when any open task issue violates the task sizing contract")
    .requiredOption("--repository <slug>", "Target repository <owner/repo>")
    .option("--repo-root <path>", "Repo root used to resolve live task worktrees")
    .option("--branch <task/...>", "Task branch used to resolve the current task snapshot hint")
    .option("--source <path>", "Offline issue JSON source (ISSUE_GRAPH_SOURCE)")
    .option("--output <path>", "Write JSON report to a file")
    .option("--task-id <TASK_ID>", "Limit certification to one canonical task")
    .option(
      "--include-overlapping-live-tasks",
      "When scoped to one task, also certify checked-out live tasks that overlap its write set",
      false
    )
    .parse(["node", "certify-task-sizing", ...argv]);

  const opts = program.opts<{
    branch?: string;
    includeOverlappingLiveTasks: boolean;
    repository: string;
    repoRoot?: string;
    source?: string;
    output?: string;
    taskId?: string;
  }>();

  return {
    branch: String(opts.branch || "").trim(),
    includeOverlappingLiveTasks: opts.includeOverlappingLiveTasks,
    repository: opts.repository,
    repoRoot: String(opts.repoRoot || "").trim(),
    sourcePath: String(opts.source || "").trim(),
    outputPath: String(opts.output || "").trim(),
    taskId: normalizeTaskId(String(opts.taskId || "").trim()),
  };
}

export function resolveScopedTaskIds(
  options: {
    issues: Awaited<ReturnType<typeof loadTaskIssues>>["issues"];
    includeOverlappingLiveTasks: boolean;
    repoRoot: string;
    taskId: string;
  },
  deps: ResolveScopedTaskIdsDeps = {}
): string[] {
  const targetTaskId = normalizeTaskId(options.taskId);
  if (!targetTaskId) {
    return [];
  }

  const buildManifest =
    deps.buildTaskScopeManifestFromTaskIssue || buildTaskScopeManifestFromTaskIssue;
  const collectConflicts = deps.collectManifestConflicts || collectManifestConflicts;
  const extractTaskId = deps.extractTaskIdFromBranch || extractTaskIdFromBranch;
  const hasRecentActivity =
    deps.hasRecentRelevantWorktreeActivity || hasRecentRelevantWorktreeActivity;
  const listWorktrees = deps.listCanonicalTaskWorktrees || listCanonicalTaskWorktrees;

  const openIssues = options.issues.filter((issue) => issue.state === "open");
  const issuesByTaskId = new Map(
    openIssues.map((issue) => [normalizeTaskId(issue.metadata.task_id), issue] as const)
  );
  const targetIssue = issuesByTaskId.get(targetTaskId);
  if (!targetIssue) {
    return [targetTaskId];
  }
  if (!options.includeOverlappingLiveTasks || !options.repoRoot) {
    return [targetTaskId];
  }

  const targetManifest = buildManifest(targetIssue);
  const overlappingTaskIds = listWorktrees(options.repoRoot)
    .filter((worktree) => hasRecentActivity(worktree.path))
    .map((worktree) => extractTaskId(worktree.branch))
    .map((taskId) => normalizeTaskId(String(taskId || "")))
    .filter((taskId) => taskId && taskId !== targetTaskId)
    .filter((taskId, index, all) => all.indexOf(taskId) === index)
    .filter((taskId) => {
      const issue = issuesByTaskId.get(taskId);
      if (!issue) {
        return false;
      }
      return collectConflicts(targetManifest, [buildManifest(issue)]).length > 0;
    });

  return [targetTaskId, ...overlappingTaskIds];
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  const issues = await loadTaskIssuesForCertification(cli);
  const scopedTaskIds = resolveScopedTaskIds({
    issues,
    includeOverlappingLiveTasks: cli.includeOverlappingLiveTasks,
    repoRoot: cli.repoRoot ? path.resolve(cli.repoRoot) : "",
    taskId: cli.taskId,
  });
  const report = collectTaskSizingCertificationReport(issues, {
    taskIds: scopedTaskIds,
  });
  const payload: OutputPayload = {
    generated_at: nowIsoUtc(),
    repository: cli.repository,
    open_task_count: report.open_task_count,
    certified_task_count: report.certified_task_count,
    failing_task_count: report.failing_task_count,
    failing_tasks: report.failing_tasks,
  };

  writeOutput(cli.outputPath, payload);

  const lines = [
    `task sizing certification | open=${report.open_task_count} | certified=${report.certified_task_count} | failing=${report.failing_task_count}${scopedTaskIds.length > 0 ? ` | scope=${scopedTaskIds.join(",")}` : ""}`,
    report.failing_task_count > 0
      ? `- failing tasks: ${report.failing_tasks.map((entry) => formatTaskRef(entry.issue_number, entry.task_id)).join(", ")}`
      : "- failing tasks: none",
  ];
  if (cli.outputPath) {
    lines.push(`- report: ${path.resolve(cli.outputPath)}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);

  if (report.failing_task_count > 0) {
    for (const failingTask of report.failing_tasks) {
      for (const error of failingTask.errors) {
        process.stderr.write(`${error}\n`);
      }
    }
    process.exit(1);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`certify-task-sizing failed: ${(error as Error).message}\n`);
    process.exit(1);
  });
}
