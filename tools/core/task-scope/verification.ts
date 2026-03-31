import { currentGitBranch, extractTaskIdFromBranch, normalizeTaskId } from "../task-issue-guard";
import {
  assertTaskScopeFiles,
  ensureCurrentTaskSessionArtifacts,
  ensureTaskScopeManifest,
} from "./manifest";
import type { TaskScopeVerificationPlan } from "./types";
import { resolveVerifyCacheStatus } from "./verify-cache";

export function createTaskScopeVerificationPlan(options: {
  branch?: string;
  changedFiles: string[];
  commands: string[];
  mergeBase: string | null;
  repoRoot: string;
  repository?: string;
  sourcePath?: string;
}): TaskScopeVerificationPlan {
  const branch = String(options.branch || "").trim() || currentGitBranch(options.repoRoot);
  const taskId = normalizeTaskId(extractTaskIdFromBranch(branch) || "");
  const sessionArtifacts = taskId
    ? ensureCurrentTaskSessionArtifacts({
        branch,
        repoRoot: options.repoRoot,
        repository: options.repository,
        sourcePath: options.sourcePath,
        taskId,
      })
    : null;
  const taskScope =
    sessionArtifacts?.manifest ||
    (taskId
      ? ensureTaskScopeManifest({
          repoRoot: options.repoRoot,
          repository: options.repository,
          sourcePath: options.sourcePath,
          taskId,
        })
      : null);

  if (taskScope) {
    assertTaskScopeFiles({
      changedFiles: options.changedFiles,
      manifest: taskScope,
    });
  }

  if (!taskScope) {
    return {
      taskScope,
      verificationClass: null,
      verifyCacheFingerprint: null,
      verifyCacheEntry: null,
      verifyCacheHit: false,
      verifyCacheReason: "no-task-scope",
      verifyCacheDetail: "branch does not resolve to a canonical task scope",
    };
  }

  if (options.commands.length === 0) {
    return {
      taskScope,
      verificationClass: taskScope.verificationClass,
      verifyCacheFingerprint: null,
      verifyCacheEntry: null,
      verifyCacheHit: false,
      verifyCacheReason: "no-commands",
      verifyCacheDetail: "no local verification commands were selected for this diff",
    };
  }

  const verifyCacheStatus = resolveVerifyCacheStatus({
    changedFiles: options.changedFiles,
    commands: options.commands,
    mergeBase: options.mergeBase,
    repoRoot: options.repoRoot,
    taskScope,
  });

  return {
    taskScope,
    verificationClass: taskScope?.verificationClass || null,
    verifyCacheFingerprint: verifyCacheStatus.fingerprint,
    verifyCacheEntry: verifyCacheStatus.entry,
    verifyCacheHit: verifyCacheStatus.reason === "hit",
    verifyCacheReason: verifyCacheStatus.reason,
    verifyCacheDetail: verifyCacheStatus.detail,
  };
}
