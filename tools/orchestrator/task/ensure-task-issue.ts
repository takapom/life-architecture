#!/usr/bin/env bun
import { fail, resolveRepoRoot, writeOutput } from "../../adapters/cli";
import { loadTaskIssuesFromSourceNodes } from "../../adapters/issue-graph-fetch";
import { listGitWorktrees } from "../../adapters/worktree";
import {
  auditTaskIssueSourceOfTruth,
  buildTaskIssueSourceFingerprint,
  collectTaskSizingFindings,
  currentGitBranch,
  detectRepositoryFromOrigin,
  extractTaskIdFromBranch,
  type GraphIssueNode,
  isTaskIssueSnapshotCurrent,
  materializeTaskScopeManifestForTaskIssue,
  normalizeTaskId,
  readTaskIssueSnapshot,
  type TaskIssueSnapshot,
  writeTaskIssueSnapshot,
} from "../../core/task-governance";
import {
  materializeRepoTaskIssueCatalogSnapshot,
  readCurrentRepoTaskIssueCatalogSnapshot,
  resolveRepoTaskIssueCatalogSnapshotPath,
} from "../../core/task-issue-catalog";
import {
  writeImmutableTaskIssueSource,
  writeImmutableTaskScopeManifest,
  writeMaterializedTaskIssueSource,
} from "../../core/task-scope/manifest";
import {
  type RepoctlTaskIssueOverlayRequest,
  runRepoctlControlPlaneTaskIssueBundle,
  runRepoctlControlPlaneTaskIssueEnsure,
} from "../../repoctl/runtime";

type Cli = {
  repoWideCatalog: boolean;
  allowClosedTaskIssue: boolean;
  repository: string;
  sourcePath: string;
  taskId: string;
  branch: string;
  useCurrentBranch: boolean;
  writeMarker: boolean;
  outputPath: string;
};

type RawIssueSnapshot = {
  number: number;
  title: string;
  body: string;
  html_url: string;
};

type LoadedTaskIssue = ReturnType<typeof loadTaskIssuesFromSourceNodes>["issues"][number];

function printUsageAndExit(): never {
  process.stdout.write(
    `${[
      "Usage:",
      "  bun tools/apps/task/ensure-task-issue.ts [options]",
      "",
      "Options:",
      "  --repository <owner/repo>",
      "  --source <path>",
      "  --task-id <TASK_ID>",
      "  --branch <name>",
      "  --from-current-branch",
      "  --repo-wide-catalog",
      "  --allow-closed-task-issue",
      "  --write-marker",
      "  --output <path>",
      "  --help",
    ].join("\n")}\n`
  );
  process.exit(0);
}

function takeRequiredOptionValue(argv: string[], index: number, flag: string): string {
  const next = argv[index + 1];
  if (!next || next.startsWith("--")) {
    fail(`${flag} requires a value`);
  }
  return next;
}

function parseCli(argv: string[]): Cli {
  const cli: Cli = {
    repoWideCatalog: false,
    allowClosedTaskIssue: false,
    repository: "",
    sourcePath: "",
    taskId: "",
    branch: "",
    useCurrentBranch: false,
    writeMarker: false,
    outputPath: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--repository":
        cli.repository = takeRequiredOptionValue(argv, index, "--repository").trim();
        index += 1;
        break;
      case "--source":
        cli.sourcePath = takeRequiredOptionValue(argv, index, "--source").trim();
        index += 1;
        break;
      case "--task-id":
        cli.taskId = normalizeTaskId(takeRequiredOptionValue(argv, index, "--task-id"));
        index += 1;
        break;
      case "--branch":
        cli.branch = takeRequiredOptionValue(argv, index, "--branch").trim();
        index += 1;
        break;
      case "--from-current-branch":
        cli.useCurrentBranch = true;
        break;
      case "--repo-wide-catalog":
        cli.repoWideCatalog = true;
        break;
      case "--allow-closed-task-issue":
        cli.allowClosedTaskIssue = true;
        break;
      case "--write-marker":
        cli.writeMarker = true;
        break;
      case "--output":
        cli.outputPath = takeRequiredOptionValue(argv, index, "--output").trim();
        index += 1;
        break;
      case "--help":
      case "-h":
        return printUsageAndExit();
      default:
        fail(`unknown argument: ${arg}`);
    }
  }

  return cli;
}

function assertRepoWideCatalogCli(cli: Cli): void {
  if (!cli.repoWideCatalog) {
    return;
  }
  if (cli.taskId || cli.branch || cli.useCurrentBranch) {
    fail("--repo-wide-catalog cannot be combined with task-branch selectors");
  }
  if (cli.writeMarker) {
    fail("--repo-wide-catalog does not accept --write-marker");
  }
  if (cli.allowClosedTaskIssue) {
    fail("--repo-wide-catalog does not accept --allow-closed-task-issue");
  }
}

function resolveBranch(cli: Cli, repoRoot: string): string {
  if (cli.branch) {
    return cli.branch;
  }
  if (cli.useCurrentBranch) {
    return currentGitBranch(repoRoot);
  }
  return "";
}

function resolveTaskId(cli: Cli, branch: string): string {
  if (cli.taskId) {
    return cli.taskId;
  }

  const extractedTaskId = extractTaskIdFromBranch(branch);
  if (!extractedTaskId) {
    fail(
      `failed to resolve task_id from branch '${branch}'. Use --task-id or follow task/<TASK_ID>-<slug> naming.`
    );
  }
  return extractedTaskId;
}

function buildIssueUrl(repository: string, issueNumber: number): string {
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    return "";
  }
  return `https://github.com/${repository}/issues/${issueNumber}`;
}

function hasParentIssueMetadata(parentIssueNumber: number, parentIssueUrl: string): boolean {
  const hasParentIssueNumber = Number.isInteger(parentIssueNumber) && parentIssueNumber > 0;
  const hasParentIssueUrl = Boolean(parentIssueUrl.trim());
  return hasParentIssueNumber && hasParentIssueUrl;
}

function buildMaterializedTaskIssueSourceSnapshot(input: {
  body: string;
  issue: LoadedTaskIssue;
  issueUrl: string;
  title: string;
}): GraphIssueNode {
  return {
    body: input.body,
    blockedBy: input.issue.graph.blockedBy,
    html_url: input.issueUrl,
    labels: input.issue.labels.map((label) => ({ name: label })),
    number: input.issue.number,
    parent: input.issue.graph.parent ? { number: input.issue.graph.parent } : null,
    state: input.issue.state,
    subIssues: input.issue.graph.subIssues,
    title: input.title,
    url: input.issueUrl,
  };
}

function formatParentSegment(parentIssueNumber: number): string {
  return parentIssueNumber > 0 ? ` | parent=#${parentIssueNumber}` : "";
}

function writeStdoutLine(message: string): void {
  process.stdout.write(`${message}\n`);
}

function writeStderrLine(message: string): void {
  process.stderr.write(`${message}\n`);
}

function writeTaskSizingWarnings(warnings: string[]): void {
  for (const warning of warnings) {
    writeStderrLine(warning);
  }
}

function failOnTaskSizingErrors(errors: string[]): void {
  if (errors.length === 0) return;
  for (const error of errors) {
    writeStderrLine(error);
  }
  if (errors.some((error) => error.includes("mix governance/docs scope"))) {
    writeStderrLine(
      "Run bun run task:backfill-sizing -- --repository <owner/repo> --source <canonical-issue-graph.json> --mixed-governance-doc-scope to audit and normalize broad open tasks under the refined lane model."
    );
  }
  fail(errors.join("\n"));
}

function readRawIssueSnapshotFromNode(node: GraphIssueNode): RawIssueSnapshot | null {
  const number = Number(node.number || 0);
  if (!Number.isInteger(number) || number <= 0) {
    return null;
  }
  return {
    number,
    title: String(node.title || "").trim(),
    body: String(node.body || ""),
    html_url: String(node.html_url || node.url || "").trim(),
  };
}

function indexRawIssueSnapshots(
  sourceNodes: ReadonlyArray<GraphIssueNode>
): Map<number, RawIssueSnapshot> {
  const out = new Map<number, RawIssueSnapshot>();
  for (const sourceNode of sourceNodes) {
    const snapshot = readRawIssueSnapshotFromNode(sourceNode);
    if (!snapshot) {
      continue;
    }
    out.set(snapshot.number, snapshot);
  }
  return out;
}

function loadTaskIssueForEnsure(options: {
  issueNumber?: number;
  repository: string;
  sourcePath: string;
  state: "all" | "open";
  taskId: string;
}): {
  issue: LoadedTaskIssue;
  rawSnapshot: RawIssueSnapshot;
} {
  const ensured = runRepoctlControlPlaneTaskIssueEnsure({
    cwd: resolveRepoRoot(),
    issueNumber: options.issueNumber,
    repository: options.repository,
    sourcePath: options.sourcePath || undefined,
    state: options.state,
    taskId: options.taskId,
  });
  const issueNode = ensured.issue as GraphIssueNode;
  const { issues } = loadTaskIssuesFromSourceNodes([issueNode], options.repository, {
    state: options.state,
  });
  const issue = issues[0];
  if (!issue) {
    fail(`repoctl task-issue ensure returned no canonical issue for ${options.taskId}`);
  }
  if (issues.length > 1) {
    fail(`repoctl task-issue ensure returned multiple canonical issues for ${options.taskId}`);
  }
  if (normalizeTaskId(issue.metadata.task_id) !== normalizeTaskId(ensured.taskId)) {
    fail(
      `repoctl task-issue ensure returned ${issue.metadata.task_id || "(missing task_id)"} for ${options.taskId}`
    );
  }
  const rawSnapshot = readRawIssueSnapshotFromNode(issueNode);
  if (!rawSnapshot) {
    fail(`repoctl task issue bundle did not include a raw snapshot for issue #${issue.number}`);
  }
  return {
    issue,
    rawSnapshot,
  };
}

function resolveSnapshotIssueNumber(options: {
  repoRoot: string;
  repository: string;
  branch: string;
  taskId: string;
}): number | undefined {
  if (!options.branch) {
    return undefined;
  }

  const snapshot = readTaskIssueSnapshot(options.repoRoot, options.branch);
  if (
    !isTaskIssueSnapshotCurrent(snapshot, {
      repository: options.repository,
      branch: options.branch,
      taskId: options.taskId,
    })
  ) {
    return undefined;
  }

  return snapshot?.issue_number;
}

function failOnTaskIssueSourceOfTruthDrift(
  result: ReturnType<typeof auditTaskIssueSourceOfTruth>
): void {
  if (result.errors.length === 0 && result.mismatches.length === 0) {
    return;
  }

  const findings = [...result.errors, ...result.mismatches];
  fail(
    [
      `task issue #${result.issue_number} (${result.task_id || "unknown task_id"}) is not canonical: ${findings.join("; ")}`,
      `Run bun run task:audit-issue-sot -- --issue-number ${result.issue_number} to inspect drift.`,
      `Run bun run task:backfill-issue-sot -- --issue-number ${result.issue_number} --apply to normalize when the issue is normalization-only.`,
    ].join(" ")
  );
}

function collectLiveTaskIssueOverlayRequests(repoRoot: string): RepoctlTaskIssueOverlayRequest[] {
  const requests = new Map<string, RepoctlTaskIssueOverlayRequest>();
  for (const worktree of listGitWorktrees(repoRoot)) {
    if (!worktree.branch.startsWith("task/")) {
      continue;
    }
    const snapshot = readTaskIssueSnapshot(repoRoot, worktree.branch);
    const taskId = normalizeTaskId(
      String(snapshot?.task_id || extractTaskIdFromBranch(worktree.branch))
    );
    const issueNumber = Number(snapshot?.issue_number || 0);
    if (!taskId || !Number.isInteger(issueNumber) || issueNumber <= 0) {
      continue;
    }
    requests.set(taskId, {
      issueNumber,
      taskId,
    });
  }
  return [...requests.values()].sort((left, right) => left.taskId.localeCompare(right.taskId));
}

function materializeRepoWideCatalog(options: {
  outputPath: string;
  repoRoot: string;
  repository: string;
  sourcePath: string;
}): void {
  const liveIssueRequests = collectLiveTaskIssueOverlayRequests(options.repoRoot);
  const baseSnapshot = !options.sourcePath
    ? readCurrentRepoTaskIssueCatalogSnapshot(options.repoRoot, options.repository)
    : null;
  if (!options.sourcePath && !baseSnapshot) {
    fail(
      `repo-wide task issue catalog snapshot is missing for ${options.repository}; materialize a canonical snapshot or pass --source`
    );
  }
  let bundleGeneratedAt = "";
  const issues = options.sourcePath
    ? (() => {
        const bundle = runRepoctlControlPlaneTaskIssueBundle({
          cwd: options.repoRoot,
          overlayRequests: liveIssueRequests,
          repository: options.repository,
          sourcePath: options.sourcePath,
          state: "all",
        });
        bundleGeneratedAt = bundle.generatedAt;
        const sourceNodes = bundle.issues as GraphIssueNode[];
        const rawSnapshots = indexRawIssueSnapshots(sourceNodes);
        return loadTaskIssuesFromSourceNodes(sourceNodes, options.repository, {
          state: "all",
        }).issues.map((issue) => {
          const rawSnapshot = rawSnapshots.get(issue.number);
          return {
            body: rawSnapshot?.body || "",
            htmlUrl: rawSnapshot?.html_url || issue.htmlUrl,
            metadata: {
              acceptance_checks: issue.metadata.acceptance_checks,
              admission_mode: issue.metadata.admission_mode,
              allowed_files: issue.metadata.allowed_files,
              deps: issue.metadata.deps,
              global_invariant: issue.metadata.global_invariant,
              task_id: issue.metadata.task_id,
              tests: issue.metadata.tests,
              unfreeze_condition: issue.metadata.unfreeze_condition,
            },
            number: issue.number,
            state: issue.state === "closed" ? "CLOSED" : "OPEN",
            taskId: issue.metadata.task_id,
            title: rawSnapshot?.title || issue.title,
          };
        });
      })()
    : baseSnapshot.issues;
  if (
    baseSnapshot &&
    !options.sourcePath &&
    issues.length === baseSnapshot.issues.length &&
    JSON.stringify(issues) === JSON.stringify(baseSnapshot.issues)
  ) {
    const result = {
      issue_count: baseSnapshot.issue_count,
      repository: baseSnapshot.repository,
      snapshot_path: resolveRepoTaskIssueCatalogSnapshotPath(options.repoRoot, options.repository),
      source_fingerprint: baseSnapshot.source_fingerprint,
      verified_at: new Date().toISOString(),
    };
    writeOutput(options.outputPath, result);
    writeStdoutLine(
      `repo-wide task issue catalog verified | repository=${baseSnapshot.repository} | issues=${baseSnapshot.issue_count} | path=${resolveRepoTaskIssueCatalogSnapshotPath(options.repoRoot, options.repository)}`
    );
    return;
  }
  const { snapshot, snapshotPath } = materializeRepoTaskIssueCatalogSnapshot({
    generatedAt: bundleGeneratedAt || undefined,
    issues,
    repoRoot: options.repoRoot,
    repository: options.repository,
  });
  const result = {
    issue_count: snapshot.issue_count,
    repository: snapshot.repository,
    snapshot_path: snapshotPath,
    source_fingerprint: snapshot.source_fingerprint,
    verified_at: snapshot.generated_at,
  };
  writeOutput(options.outputPath, result);
  writeStdoutLine(
    `repo-wide task issue catalog refreshed | repository=${snapshot.repository} | issues=${snapshot.issue_count} | path=${snapshotPath}`
  );
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  assertRepoWideCatalogCli(cli);
  const repoRoot = resolveRepoRoot();
  const repository = cli.repository || detectRepositoryFromOrigin(repoRoot);
  if (cli.repoWideCatalog) {
    await materializeRepoWideCatalog({
      outputPath: cli.outputPath,
      repoRoot,
      repository,
      sourcePath: cli.sourcePath || undefined,
    });
    return;
  }
  const branch = resolveBranch(cli, repoRoot);
  const taskId = resolveTaskId(cli, branch);
  const sourcePath = cli.sourcePath;
  const snapshotIssueNumber = resolveSnapshotIssueNumber({
    repoRoot,
    repository,
    branch,
    taskId,
  });

  if (cli.writeMarker && !branch) {
    fail("--write-marker requires --branch or --from-current-branch");
  }

  const { issue, rawSnapshot } = await loadTaskIssueForEnsure({
    taskId,
    sourcePath,
    repository,
    issueNumber: snapshotIssueNumber,
    state: cli.allowClosedTaskIssue ? "all" : "open",
  });
  failOnTaskIssueSourceOfTruthDrift(
    auditTaskIssueSourceOfTruth({
      issue,
      title: rawSnapshot.title,
      body: rawSnapshot.body,
    })
  );

  const parentIssueNumber = Number(issue.graph.parent || 0);
  const issueUrl = rawSnapshot.html_url || issue.htmlUrl || buildIssueUrl(repository, issue.number);
  const sourceFingerprint = buildTaskIssueSourceFingerprint({
    issueNumber: issue.number,
    title: rawSnapshot.title,
    body: rawSnapshot.body,
    issueUrl,
    state: issue.state,
  });
  const taskSizingFindings = collectTaskSizingFindings({
    issueNumber: issue.number,
    taskId: issue.metadata.task_id,
    admissionMode: issue.metadata.admission_mode,
    globalInvariant: issue.metadata.global_invariant,
    unfreezeCondition: issue.metadata.unfreeze_condition,
    allowedFiles: issue.metadata.allowed_files,
    commitUnits: issue.metadata.commit_units,
    reviewerOutcomes: issue.metadata.reviewer_outcomes,
    canonicalGap: issue.metadata.canonical_gap,
    canonicalGapOwner: issue.metadata.canonical_gap_owner,
    canonicalGapReviewDate: issue.metadata.canonical_gap_review_date,
    canonicalDeferralReason: issue.metadata.canonical_deferral_reason,
    canonicalDeferralCondition: issue.metadata.canonical_deferral_condition,
    linkedChildTaskCount: issue.graph.subIssues.length,
    taskSizingException: issue.metadata.task_sizing_exception,
    taskSizingExceptionType: issue.metadata.task_sizing_exception_type,
    taskSizingSplitFailure: issue.metadata.task_sizing_split_failure,
    taskSizingExceptionReviewerAttestation:
      issue.metadata.task_sizing_exception_reviewer_attestation,
    taskSizingUnsafeState: issue.metadata.task_sizing_unsafe_state,
    taskSizingAffectedInvariant: issue.metadata.task_sizing_affected_invariant,
    taskSizingAtomicBoundary: issue.metadata.task_sizing_atomic_boundary,
  });
  const { errors: taskSizingErrors, warnings: taskSizingWarnings } = taskSizingFindings;
  failOnTaskSizingErrors(taskSizingErrors);
  const { manifest } = materializeTaskScopeManifestForTaskIssue({
    issue,
    repoRoot,
  });

  const result = {
    repository,
    branch,
    task_id: taskId,
    issue_number: issue.number,
    issue_url: issueUrl,
    ...(taskSizingWarnings.length > 0 ? { task_sizing_warnings: taskSizingWarnings } : {}),
    ...(parentIssueNumber > 0
      ? {
          parent_issue_number: parentIssueNumber,
          parent_issue_url: buildIssueUrl(repository, parentIssueNumber),
        }
      : {}),
    source_fingerprint: sourceFingerprint,
    status: issue.metadata.status,
    verified_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  };

  if (cli.writeMarker && branch) {
    const parentIssueUrl = buildIssueUrl(repository, parentIssueNumber);
    const snapshot: TaskIssueSnapshot = {
      version: 1,
      repository,
      branch,
      task_id: taskId,
      issue_number: result.issue_number,
      issue_url: result.issue_url,
      ...(hasParentIssueMetadata(parentIssueNumber, parentIssueUrl)
        ? {
            parent_issue_number: parentIssueNumber,
            parent_issue_url: parentIssueUrl,
          }
        : {}),
      source_fingerprint: result.source_fingerprint,
      verified_at: result.verified_at,
    };
    writeTaskIssueSnapshot(repoRoot, snapshot);
    writeImmutableTaskIssueSource({
      repoRoot,
      branch,
      sourceFingerprint,
      snapshots: [
        buildMaterializedTaskIssueSourceSnapshot({
          issue,
          issueUrl,
          title: rawSnapshot.title,
          body: rawSnapshot.body,
        }),
      ],
    });
    writeImmutableTaskScopeManifest({
      repoRoot,
      branch,
      sourceFingerprint,
      manifest,
    });
    writeMaterializedTaskIssueSource({
      repoRoot,
      branch,
      snapshots: [
        buildMaterializedTaskIssueSourceSnapshot({
          issue,
          issueUrl,
          title: rawSnapshot.title,
          body: rawSnapshot.body,
        }),
      ],
    });
  }

  writeOutput(cli.outputPath, result);
  writeTaskSizingWarnings(taskSizingWarnings);
  writeStdoutLine(
    `task issue verified | repository=${repository} | branch=${branch || "(none)"} | task_id=${taskId} | issue=#${issue.number}${formatParentSegment(parentIssueNumber)} | status=${issue.metadata.status}`
  );
}

main().catch((error) => {
  writeStderrLine(`ensure-task-issue failed: ${(error as Error).message}`);
  process.exitCode = 1;
});
