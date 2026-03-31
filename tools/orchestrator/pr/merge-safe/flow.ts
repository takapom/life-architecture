import { spawnSync } from "node:child_process";
import { extractTaskIdFromBranch } from "../../../core/task-governance";
import { resolveRepoTaskIssueCatalogSummariesWithRepair } from "../../../core/task-issue-catalog";
import {
  collectLandingExclusiveConflicts,
  isLandingExclusiveAdmissionMode,
  listOpenPullRequests,
  renderLandingExclusiveConflictMessage,
} from "../landing-exclusive";
import {
  resolveCleanupWorktree,
  runCleanupForMergedPr,
  shouldReanchorCleanupToMainWorktree,
} from "./cleanup";
import {
  fail,
  isQueueUnavailable,
  printDryRun,
  runCommand,
  runGh,
  writeStdoutLine,
} from "./common";
import { CLEANUP_REANCHORED_ENV, type CliOptions, type PrInfo } from "./contracts";
import { classifyCanonicalPrLifecycleState, fetchPrInfo } from "./github";
import { resolveMergePrContext } from "./prepare";

async function assertLandingExclusiveMergeLane(options: {
  prInfo: Pick<PrInfo, "baseBranch" | "headBranch" | "number">;
  repoRoot: string;
  repository: string;
}): Promise<void> {
  const taskId = extractTaskIdFromBranch(options.prInfo.headBranch);
  if (!taskId) {
    return;
  }

  const currentIssues = await resolveRepoTaskIssueCatalogSummariesWithRepair({
    repoRoot: options.repoRoot,
    repository: options.repository,
    taskIds: [taskId],
  });
  const currentIssue = currentIssues.find((issue) => issue.taskId === taskId);
  if (!isLandingExclusiveAdmissionMode(currentIssue?.metadata.admission_mode)) {
    return;
  }

  const openPullRequests = listOpenPullRequests(options.repository, (args) => runGh(args));
  const relatedTaskIds = [
    taskId,
    ...openPullRequests
      .filter((pr) => pr.baseBranch === options.prInfo.baseBranch)
      .filter((pr) => pr.number !== options.prInfo.number)
      .map((pr) => extractTaskIdFromBranch(pr.headBranch) || "")
      .filter(Boolean),
  ];
  const taskIssues = await resolveRepoTaskIssueCatalogSummariesWithRepair({
    repoRoot: options.repoRoot,
    repository: options.repository,
    taskIds: relatedTaskIds,
  });
  const conflicts = collectLandingExclusiveConflicts({
    baseBranch: options.prInfo.baseBranch,
    taskIssues,
    currentPrNumber: options.prInfo.number,
    currentTaskId: taskId,
    openPullRequests,
  });
  if (conflicts.length === 0) {
    return;
  }

  fail(
    renderLandingExclusiveConflictMessage({
      conflicts,
      surface: "pr:merge:safe",
      taskId,
    })
  );
}

export type SafeMergeRuntime = {
  cleanupReanchoredEnv: string | undefined;
  entrypointPath: string;
  env: NodeJS.ProcessEnv;
  execPath: string;
};

function reanchorCleanupToMainWorktree(options: {
  cleanupWorktree: string;
  dryRun: boolean;
  entrypointPath: string;
  execPath: string;
  prInfo: Pick<PrInfo, "number">;
  repository: string;
  runtimeEnv: NodeJS.ProcessEnv;
}): void {
  const reanchorArgs = [
    options.execPath,
    options.entrypointPath,
    "--pr",
    options.prInfo.number,
    "--cleanup-only",
    "--repository",
    options.repository,
  ];
  if (options.dryRun) {
    reanchorArgs.push("--dry-run");
  }

  writeStdoutLine(`[pr-merge-safe] re-anchor cleanup to main worktree: ${options.cleanupWorktree}`);
  if (options.dryRun) {
    printDryRun(reanchorArgs);
    return;
  }

  const result = spawnSync(reanchorArgs[0], reanchorArgs.slice(1), {
    cwd: options.cleanupWorktree,
    env: {
      ...options.runtimeEnv,
      [CLEANUP_REANCHORED_ENV]: "1",
      OMTA_PR_MERGE_REPO_ROOT: options.cleanupWorktree,
    },
    stdio: "inherit",
  });
  if (result.error) {
    fail(`failed to re-anchor cleanup to ${options.cleanupWorktree}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

async function mergePrIfNeeded(options: {
  cli: CliOptions;
  prInfo: PrInfo;
  repository: string;
}): Promise<PrInfo> {
  let prInfo = options.prInfo;
  let lifecycleState = classifyCanonicalPrLifecycleState(prInfo);

  if (lifecycleState === "closed-unmerged") {
    fail(`PR is closed without merge and cannot be processed by pr:merge:safe: ${prInfo.url}`);
  }

  if (options.cli.cleanupOnly) {
    if (lifecycleState !== "merged") {
      fail(`cleanup-only requires a merged PR: ${prInfo.url}`);
    }
    return prInfo;
  }

  if (lifecycleState === "merged") {
    return prInfo;
  }

  await assertLandingExclusiveMergeLane({
    prInfo,
    repoRoot: options.cli.repoRoot,
    repository: options.repository,
  });

  const mergeArgs = ["gh", "pr", "merge", prInfo.number];
  if (options.repository) {
    mergeArgs.push("--repo", options.repository);
  }
  mergeArgs.push(`--${options.cli.method}`);

  const runDirectMerge = (): void => {
    if (options.cli.dryRun) {
      printDryRun(mergeArgs);
      return;
    }
    runCommand("gh", mergeArgs.slice(1));
    prInfo = fetchPrInfo(options.repository, prInfo.number);
    lifecycleState = classifyCanonicalPrLifecycleState(prInfo);
    if (lifecycleState !== "merged") {
      fail(`PR is not merged after direct merge command: ${prInfo.url}`);
    }
  };

  const queueArgs = mergeArgs.slice(1).concat("--auto");
  const runQueueMerge = (): "fallback-to-direct" | "queued-or-merged" => {
    if (options.cli.dryRun) {
      printDryRun(["gh", ...queueArgs]);
    } else {
      const queueResult = runGh(queueArgs, { allowFailure: true });
      if (queueResult.status !== 0) {
        const detail = `${queueResult.stderr}\n${queueResult.stdout}`.trim();
        if (isQueueUnavailable(detail)) {
          if (options.cli.mergeMode === "require-queue") {
            fail(`queue-required merge is unavailable for this repository: ${detail}`);
          }
          writeStdoutLine("[pr-merge-safe] queue unavailable; falling back to direct merge");
          return "fallback-to-direct";
        }
        fail(`gh ${queueArgs.join(" ")} failed: ${detail || `exit=${queueResult.status}`}`);
      }
    }

    prInfo = fetchPrInfo(options.repository, prInfo.number);
    lifecycleState = classifyCanonicalPrLifecycleState(prInfo);
    if (lifecycleState === "open") {
      writeStdoutLine(`[pr-merge-safe] queued for merge: ${prInfo.url}`);
      if (options.cli.cleanup) {
        fail("cleanup requires merged PR. Wait for queue completion, then re-run with --cleanup.");
      }
      return "queued-or-merged";
    }
    if (lifecycleState !== "merged") {
      fail(`PR is neither merged nor queued after queue command: ${prInfo.url}`);
    }
    return "queued-or-merged";
  };

  const shouldPreferDirectMerge =
    options.cli.mergeMode === "direct" ||
    (options.cli.mergeMode === "auto" &&
      prInfo.mergeable === "MERGEABLE" &&
      prInfo.mergeStateStatus === "CLEAN");

  if (shouldPreferDirectMerge) {
    runDirectMerge();
    return prInfo;
  }

  const queueResult = runQueueMerge();
  if (queueResult === "fallback-to-direct") {
    runDirectMerge();
    return prInfo;
  }
  if (lifecycleState === "open") {
    return prInfo;
  }
  return prInfo;
}

export async function runSafeMerge(options: CliOptions, runtime: SafeMergeRuntime): Promise<void> {
  const prepared = resolveMergePrContext(options);
  const prInfo = await mergePrIfNeeded({
    cli: options,
    prInfo: prepared.prInfo,
    repository: prepared.prRepository,
  });
  const lifecycleState =
    prInfo.number === prepared.prInfo.number &&
    prInfo.headSha === prepared.prInfo.headSha &&
    prInfo.state === prepared.prInfo.state
      ? prepared.lifecycleState
      : classifyCanonicalPrLifecycleState(prInfo);
  if (lifecycleState === "open") {
    return;
  }

  writeStdoutLine(`[pr-merge-safe] merged: ${prInfo.url}`);

  if (!options.cleanup) {
    writeStdoutLine("[pr-merge-safe] cleanup skipped (default-safe mode)");
    let cleanupCommand = `bun run pr:cleanup -- --pr ${prInfo.number}`;
    if (options.repository) {
      cleanupCommand += ` --repository ${options.repository}`;
    }
    writeStdoutLine(`[pr-merge-safe] cleanup command: ${cleanupCommand}`);
    return;
  }

  const cleanupWorktree = resolveCleanupWorktree(options.repoRoot);
  writeStdoutLine(`[pr-merge-safe] cleanup worktree: ${cleanupWorktree}`);
  if (
    shouldReanchorCleanupToMainWorktree({
      callerRepoRoot: options.repoRoot,
      cleanupWorktree,
    }) &&
    runtime.cleanupReanchoredEnv !== "1"
  ) {
    reanchorCleanupToMainWorktree({
      cleanupWorktree,
      dryRun: options.dryRun,
      entrypointPath: runtime.entrypointPath,
      execPath: runtime.execPath,
      prInfo,
      repository: prepared.prRepository,
      runtimeEnv: runtime.env,
    });
    return;
  }

  runCleanupForMergedPr({
    callerRepoRoot: options.repoRoot,
    cleanupWorktree,
    dryRun: options.dryRun,
    prInfo,
    repository: prepared.prRepository,
  });
}
