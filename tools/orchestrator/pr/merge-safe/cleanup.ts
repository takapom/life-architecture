import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  canonicalPath,
  extractTaskIdFromWorktreeEntry,
  isTaskWorktreeProtectionLeaseActive,
  listGitWorktrees,
  readTaskWorktreeProtectionLease,
  resolveCanonicalArchiveRootFromRepoRoot,
  resolveCanonicalMainWorktree,
  resolveCanonicalTaskRootFromRepoRoot,
  resolveDependencyMaterializationScriptPath,
  resolveTaskWorktreeProtectionRootFromRepoRoot,
} from "../../../adapters/worktree";
import { extractTaskIdFromBranch, normalizeTaskId } from "../../../core/task-governance";
import { fail, printDryRun, runCommand, runGh, runGit, writeStdoutLine } from "./common";
import type {
  BranchRefDeletionDisposition,
  MergedTaskWorktreeDisposition,
  PrInfo,
  RemoteBranchDeleteResult,
} from "./contracts";

function sanitizeFileComponent(value: string): string {
  return (
    String(value || "")
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "cleanup"
  );
}

function buildArchiveDirectoryPath(cleanupWorktree: string, branch: string, suffix = ""): string {
  const taskId = normalizeTaskId(extractTaskIdFromBranch(branch) || "");
  const archiveLabel = sanitizeFileComponent([taskId || branch, suffix].filter(Boolean).join("-"));
  const timestamp = new Date()
    .toISOString()
    .replace(/[:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return path.join(
    resolveCanonicalArchiveRootFromRepoRoot(cleanupWorktree),
    `${timestamp}-${archiveLabel}`
  );
}

function isCommitOid(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(String(value || "").trim());
}

function countUniqueCommitsAgainstOriginMain(worktreePath: string): number {
  const output = runGit(worktreePath, ["rev-list", "--count", "origin/main..HEAD"], {
    allowFailure: true,
  });
  const parsed = Number.parseInt(output, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function readHeadCommitSha(repoRoot: string): string {
  const output = runGit(repoRoot, ["rev-parse", "HEAD"], {
    allowFailure: true,
  });
  return isCommitOid(output) ? output : "";
}

function readLocalBranchHeadSha(repoRoot: string, branch: string): string {
  const output = runGit(repoRoot, ["rev-parse", "--verify", `refs/heads/${branch}`], {
    allowFailure: true,
  });
  return isCommitOid(output) ? output : "";
}

function readRemoteBranchHeadSha(repoRoot: string, branch: string): string {
  const remoteRef = `refs/heads/${branch}`;
  const output = runGit(repoRoot, ["ls-remote", "--heads", "origin", branch], {
    allowFailure: true,
  });
  const matches = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/))
    .filter((parts) => parts.length >= 2 && parts[1] === remoteRef);
  if (matches.length !== 1) {
    return "";
  }
  const remoteOid = String(matches[0]?.[0] || "").trim();
  return isCommitOid(remoteOid) ? remoteOid : "";
}

function isDirtyWorktree(worktreePath: string): boolean {
  return runGit(worktreePath, ["status", "--short"], { allowFailure: true }).length > 0;
}

export function classifyMergedTaskWorktreeDisposition(input: {
  dirty: boolean;
  prHeadSha: string;
  worktreeHeadSha: string;
}): MergedTaskWorktreeDisposition {
  const reasons: string[] = [];
  if (input.dirty) {
    reasons.push("dirty-worktree");
  }
  if (!isCommitOid(input.prHeadSha)) {
    reasons.push("invalid-pr-head");
  }
  if (!isCommitOid(input.worktreeHeadSha)) {
    reasons.push("invalid-worktree-head");
  } else if (isCommitOid(input.prHeadSha) && input.worktreeHeadSha !== input.prHeadSha) {
    reasons.push("worktree-head-diverged");
  }
  return {
    reasons,
    requiresArchive: reasons.length > 0,
  };
}

export function classifyBranchRefDeletionDisposition(input: {
  headBranch: string;
  localBranchSha: string;
  prHeadSha: string;
  remainingCheckouts: string[];
  remoteBranchSha: string;
}): BranchRefDeletionDisposition {
  const reasons: string[] = [];
  if (input.remainingCheckouts.length > 0) {
    reasons.push(
      `${input.headBranch} is still checked out: ${input.remainingCheckouts.join(", ")}`
    );
  }
  if (!isCommitOid(input.prHeadSha)) {
    reasons.push(`merged PR head is missing or invalid for ${input.headBranch}`);
  }
  if (
    isCommitOid(input.localBranchSha) &&
    isCommitOid(input.prHeadSha) &&
    input.localBranchSha !== input.prHeadSha
  ) {
    reasons.push(`${input.headBranch} local ref moved past merged PR head`);
  }
  if (
    isCommitOid(input.remoteBranchSha) &&
    isCommitOid(input.prHeadSha) &&
    input.remoteBranchSha !== input.prHeadSha
  ) {
    reasons.push(`${input.headBranch} remote ref moved past merged PR head`);
  }
  return {
    mayDelete: reasons.length === 0,
    reasons,
  };
}

export function resolveCleanupWorktree(repoRoot: string): string {
  const cleanupWorktree = resolveCanonicalMainWorktree(repoRoot);
  const cleanupBranch = runGit(cleanupWorktree, ["rev-parse", "--abbrev-ref", "HEAD"], {
    allowFailure: true,
  });
  if (cleanupBranch !== "main") {
    fail(
      `base worktree drift detected: ${cleanupWorktree} is not on main. Run: bun run wt:cleanup:repair-base-worktree`
    );
  }
  return cleanupWorktree;
}

function archiveTaskWorktree(options: {
  archiveReasons: string[];
  archiveSuffix?: string;
  branch: string;
  cleanupWorktree: string;
  prHeadSha: string;
  targetWorktree: string;
  targetWorktreeHeadSha: string;
}): string {
  const archiveDir = buildArchiveDirectoryPath(
    options.cleanupWorktree,
    options.branch,
    options.archiveSuffix || ""
  );
  mkdirSync(archiveDir, { recursive: true });
  writeFileSync(
    path.join(archiveDir, "metadata.json"),
    `${JSON.stringify(
      {
        archived_at: new Date().toISOString(),
        archive_reasons: options.archiveReasons,
        branch: options.branch,
        pr_head_sha: options.prHeadSha,
        reason: "merged-pr-cleanup-residue",
        target_worktree: options.targetWorktree,
        target_worktree_head_sha: options.targetWorktreeHeadSha,
        unique_commits_against_origin_main: countUniqueCommitsAgainstOriginMain(
          options.targetWorktree
        ),
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  writeFileSync(
    path.join(archiveDir, "status.txt"),
    `${runGit(options.targetWorktree, ["status", "--short", "--branch"], { allowFailure: true })}\n`,
    "utf8"
  );
  writeFileSync(
    path.join(archiveDir, "diff.patch"),
    `${runGit(options.targetWorktree, ["diff", "--binary", "--no-ext-diff"], { allowFailure: true })}\n`,
    "utf8"
  );
  writeFileSync(
    path.join(archiveDir, "diff-staged.patch"),
    `${runGit(options.targetWorktree, ["diff", "--cached", "--binary", "--no-ext-diff"], {
      allowFailure: true,
    })}\n`,
    "utf8"
  );
  return archiveDir;
}

function listBranchCheckouts(repoRoot: string, branch: string): string[] {
  return listGitWorktrees(repoRoot)
    .filter((worktree) => worktree.branch === branch)
    .map((worktree) => worktree.path)
    .sort((left, right) => left.localeCompare(right));
}

export function findSupplementalMergedTaskWorktrees(input: {
  headBranch: string;
  taskRoot: string;
  worktrees: ReadonlyArray<{ branch: string; path: string }>;
}): string[] {
  const taskId = normalizeTaskId(extractTaskIdFromBranch(input.headBranch) || "");
  if (!taskId) {
    return [];
  }

  return input.worktrees
    .filter((worktree) => path.dirname(worktree.path) === input.taskRoot)
    .filter((worktree) => worktree.branch !== input.headBranch)
    .filter(
      (worktree) =>
        normalizeTaskId(extractTaskIdFromWorktreeEntry(path.basename(worktree.path)) || "") ===
        taskId
    )
    .map((worktree) => worktree.path)
    .sort((left, right) => left.localeCompare(right));
}

function isMissingGitRef(detail: string): boolean {
  return (
    /reference does not exist/i.test(detail) || /\b404\b/.test(detail) || /not found/i.test(detail)
  );
}

export function classifyRemoteBranchDeleteResult(
  status: number,
  detail: string
): RemoteBranchDeleteResult {
  if (status === 0) {
    return "deleted";
  }
  if (isMissingGitRef(detail)) {
    return "already-gone";
  }
  fail(`failed to delete remote branch: ${detail || `exit=${status}`}`);
}

function deleteRemoteBranch(repository: string, branch: string, dryRun: boolean): void {
  const args = [
    "gh",
    "api",
    "-X",
    "DELETE",
    `repos/${repository}/git/refs/heads/${encodeURIComponent(branch)}`,
  ];
  if (dryRun) {
    printDryRun(args);
    return;
  }
  const result = runGh(args.slice(1), { allowFailure: true });
  const detail = `${result.stderr}\n${result.stdout}`.trim();
  const deleteResult = classifyRemoteBranchDeleteResult(result.status, detail);
  if (deleteResult === "already-gone") {
    writeStdoutLine(`[pr-merge-safe] cleanup remote branch already absent: ${branch}`);
  }
}

function deleteLocalBranch(repoRoot: string, branch: string, dryRun: boolean): void {
  if (!runGit(repoRoot, ["branch", "--list", branch], { allowFailure: true })) {
    return;
  }
  const args = ["git", "-C", repoRoot, "branch", "-D", branch];
  if (dryRun) {
    printDryRun(args);
    return;
  }
  runCommand(args[0], args.slice(1));
}

export function shouldReanchorCleanupToMainWorktree(input: {
  callerRepoRoot: string;
  cleanupWorktree: string;
}): boolean {
  return canonicalPath(input.callerRepoRoot) !== canonicalPath(input.cleanupWorktree);
}

function cleanupMaterializedDependencies(
  cleanupWorktree: string,
  targetWorktree: string,
  dryRun: boolean
): void {
  const helperPath = resolveDependencyMaterializationScriptPath(cleanupWorktree);
  const args = [
    "bash",
    helperPath,
    "cleanup",
    "--repo-root",
    cleanupWorktree,
    "--worktree",
    targetWorktree,
  ];
  if (dryRun) {
    args.push("--dry-run");
    printDryRun(args);
    return;
  }
  runCommand(args[0], args.slice(1));
}

export function resolveTaskWorktreeProtectionLeasePath(
  cleanupWorktree: string,
  targetWorktree: string
): string {
  return path.join(
    resolveTaskWorktreeProtectionRootFromRepoRoot(cleanupWorktree),
    `${createHash("sha1").update(canonicalPath(targetWorktree)).digest("hex")}.json`
  );
}

export function clearMergedTaskCleanupProtectionLease(options: {
  cleanupWorktree: string;
  dryRun: boolean;
  targetWorktree: string;
}): string {
  const leasePath = resolveTaskWorktreeProtectionLeasePath(
    options.cleanupWorktree,
    options.targetWorktree
  );
  if (options.dryRun) {
    printDryRun(["rm", "-f", leasePath]);
    return leasePath;
  }
  rmSync(leasePath, { force: true });
  return leasePath;
}

function removeMergedTaskWorktree(options: {
  archiveSuffix?: string;
  cleanupWorktree: string;
  dryRun: boolean;
  prInfo: Pick<PrInfo, "headBranch" | "headSha">;
  requiresArchive: boolean;
  targetWorktree: string;
  worktreeDisposition: MergedTaskWorktreeDisposition;
}): void {
  const protectionLease = readTaskWorktreeProtectionLease(
    options.cleanupWorktree,
    options.targetWorktree
  );
  if (isTaskWorktreeProtectionLeaseActive(protectionLease)) {
    const leasePath = clearMergedTaskCleanupProtectionLease({
      cleanupWorktree: options.cleanupWorktree,
      dryRun: options.dryRun,
      targetWorktree: options.targetWorktree,
    });
    writeStdoutLine(
      `[pr-merge-safe] cleanup cleared active protection lease for merged task worktree: ${leasePath}`
    );
  }

  if (options.requiresArchive) {
    const archiveDir = buildArchiveDirectoryPath(
      options.cleanupWorktree,
      options.prInfo.headBranch,
      options.archiveSuffix || ""
    );
    writeStdoutLine(`[pr-merge-safe] cleanup archive: ${archiveDir}`);
    for (const reason of options.worktreeDisposition.reasons) {
      writeStdoutLine(`[pr-merge-safe] cleanup archive reason: ${reason}`);
    }
    if (!options.dryRun) {
      archiveTaskWorktree({
        archiveReasons: options.worktreeDisposition.reasons,
        archiveSuffix: options.archiveSuffix,
        branch: options.prInfo.headBranch,
        cleanupWorktree: options.cleanupWorktree,
        prHeadSha: options.prInfo.headSha,
        targetWorktree: options.targetWorktree,
        targetWorktreeHeadSha: readHeadCommitSha(options.targetWorktree),
      });
    }
  }

  cleanupMaterializedDependencies(options.cleanupWorktree, options.targetWorktree, options.dryRun);

  const removeArgs = ["git", "-C", options.cleanupWorktree, "worktree", "remove"];
  if (options.requiresArchive) {
    removeArgs.push("--force");
  }
  removeArgs.push(options.targetWorktree);
  if (options.dryRun) {
    printDryRun(removeArgs);
    return;
  }
  runCommand(removeArgs[0], removeArgs.slice(1));
}

export function runCleanupForMergedPr(options: {
  callerRepoRoot: string;
  cleanupWorktree: string;
  dryRun: boolean;
  prInfo: PrInfo;
  repository: string;
}): void {
  const callerRepoRoot = canonicalPath(options.callerRepoRoot);
  const cleanupWorktree = canonicalPath(options.cleanupWorktree);
  const taskRoot = resolveCanonicalTaskRootFromRepoRoot(cleanupWorktree);
  const registeredWorktrees = listGitWorktrees(cleanupWorktree);
  const branchCheckouts = listBranchCheckouts(cleanupWorktree, options.prInfo.headBranch);
  const canonicalTaskBranchCheckouts = branchCheckouts.filter(
    (worktreePath) => path.dirname(worktreePath) === taskRoot
  );
  const nonCanonicalBranchCheckouts = branchCheckouts.filter(
    (worktreePath) => path.dirname(worktreePath) !== taskRoot
  );

  if (nonCanonicalBranchCheckouts.length > 0) {
    fail(
      `cleanup refused: ${options.prInfo.headBranch} is still checked out outside canonical ${taskRoot}: ${nonCanonicalBranchCheckouts.join(", ")}`
    );
  }
  if (canonicalTaskBranchCheckouts.length > 1) {
    fail(
      `cleanup refused: multiple canonical task worktrees still check out ${options.prInfo.headBranch}: ${canonicalTaskBranchCheckouts.join(", ")}`
    );
  }

  let branchRefsMayBeDeleted = true;
  const targetWorktree = canonicalTaskBranchCheckouts[0] || "";
  const supplementalWorktrees = findSupplementalMergedTaskWorktrees({
    headBranch: options.prInfo.headBranch,
    taskRoot,
    worktrees: registeredWorktrees,
  }).filter((worktreePath) => worktreePath !== targetWorktree);
  const localBranchSha = readLocalBranchHeadSha(cleanupWorktree, options.prInfo.headBranch);
  const remoteBranchSha = readRemoteBranchHeadSha(cleanupWorktree, options.prInfo.headBranch);

  if (targetWorktree) {
    if (targetWorktree === callerRepoRoot) {
      fail(
        `cleanup refused: target branch ${options.prInfo.headBranch} is still checked out in the caller worktree ${callerRepoRoot}`
      );
    }

    const worktreeDisposition = classifyMergedTaskWorktreeDisposition({
      dirty: isDirtyWorktree(targetWorktree),
      prHeadSha: options.prInfo.headSha,
      worktreeHeadSha: readHeadCommitSha(targetWorktree),
    });
    const requiresArchive = worktreeDisposition.requiresArchive;

    if (requiresArchive) {
      branchRefsMayBeDeleted = false;
    }
    removeMergedTaskWorktree({
      cleanupWorktree,
      dryRun: options.dryRun,
      prInfo: options.prInfo,
      requiresArchive,
      targetWorktree,
      worktreeDisposition,
    });
  }

  for (const supplementalWorktree of supplementalWorktrees) {
    const worktreeDisposition = classifyMergedTaskWorktreeDisposition({
      dirty: isDirtyWorktree(supplementalWorktree),
      prHeadSha: options.prInfo.headSha,
      worktreeHeadSha: readHeadCommitSha(supplementalWorktree),
    });
    if (worktreeDisposition.requiresArchive) {
      branchRefsMayBeDeleted = false;
    }
    removeMergedTaskWorktree({
      archiveSuffix: path.basename(supplementalWorktree),
      cleanupWorktree,
      dryRun: options.dryRun,
      prInfo: options.prInfo,
      requiresArchive: worktreeDisposition.requiresArchive,
      targetWorktree: supplementalWorktree,
      worktreeDisposition,
    });
  }

  const remainingCheckouts =
    targetWorktree && options.dryRun
      ? branchCheckouts.filter((worktreePath) => worktreePath !== targetWorktree)
      : listBranchCheckouts(cleanupWorktree, options.prInfo.headBranch);
  const branchRefDisposition = classifyBranchRefDeletionDisposition({
    headBranch: options.prInfo.headBranch,
    localBranchSha,
    prHeadSha: options.prInfo.headSha,
    remainingCheckouts,
    remoteBranchSha,
  });
  if (!branchRefDisposition.mayDelete) {
    branchRefsMayBeDeleted = false;
    for (const reason of branchRefDisposition.reasons) {
      writeStdoutLine(`[pr-merge-safe] cleanup preserved branch refs: ${reason}`);
    }
  }

  if (!branchRefsMayBeDeleted) {
    return;
  }

  deleteRemoteBranch(options.repository, options.prInfo.headBranch, options.dryRun);
  deleteLocalBranch(cleanupWorktree, options.prInfo.headBranch, options.dryRun);
}
