#!/usr/bin/env bun

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import {
  enforceStateDirPolicy,
  resolveDefaultWorktreeRoot,
  resolveSessionId as resolveSharedSessionId,
  resolveStateBackend,
  resolveStateDirForSession,
} from "../shared/runtime_policy";
import { resolveSessionArtifactPaths } from "../shared/session_artifacts";
import {
  readSessionDecisionPayloadSnapshot,
  readSessionExecutionPlanArtifact,
} from "../shared/session_state";
import {
  buildCleanupPlan as buildCleanupPlanCore,
  buildCleanupTargets as buildCleanupTargetsCore,
  buildManagedWorktreeArchiveTargets as buildManagedWorktreeArchiveTargetsCore,
  buildManagedWorktreeDeleteTargets as buildManagedWorktreeDeleteTargetsCore,
  buildManagedWorktreeResidueSummary as buildManagedWorktreeResidueSummaryCore,
  buildPlannedCleanupResult,
  describeCleanupFailure,
  parseCleanupPlan as parseCleanupPlanCore,
} from "./close/cleanup";
import {
  fail,
  isObject,
  pathIsWithin,
  readJsonFile,
  resolveCanonicalPath,
  resolveOutputPath,
  run,
  runResult,
  writeJsonFile,
} from "./close/common";
import {
  BROKEN_WORKTREE_DIR_MARKER,
  type CleanupPlan,
  type CleanupResult,
  type Cli,
  EPHEMERAL_UNREGISTERED_TOP_LEVEL_NAMES,
  INVALID_WORKTREE_GROUP,
  type JsonObject,
  MANAGED_WORKTREE_DIR_PATTERN,
  MANAGED_WORKTREE_ROOT_ENV,
  type ManagedWorktreeArchiveTarget,
  type ParentIssueSyncScope,
  type RepoSafetyBlockingReason,
  type RepoSafetySummary,
  type RepoSafetyUnregisteredManagedDirClassification,
  type RepoSafetyUnregisteredManagedDirDisposition,
  type RepoSafetyUnregisteredManagedDirDispositionCounts,
  type RepoSafetyUnregisteredManagedDirGitState,
  type RepoSafetyUnregisteredManagedDirReason,
  type ResidueItem,
  UNREGISTERED_DIR_PREVIEW_LIMIT,
  type WorktreeClassification,
  type WorktreeClassificationSummary,
} from "./close/contracts";
import {
  appendCloseRuntimeEvent,
  emitSessionManifest,
  resolveGithubRunContextForClose as resolveGithubRunContextForCloseCore,
  runCloseCommandWithLifecycle,
  shouldRunParentIssueSync as shouldRunParentIssueSyncCore,
  syncParentIssueStatus,
} from "./close/lifecycle";
import {
  buildCleanupApplySummary,
  buildCleanupPlanSummary,
  buildCloseRunNextActions,
  buildCloseRunSummary,
  buildVerifyCloseoutSummary,
} from "./close/report";
import {
  buildFollowupDrafts as buildFollowupDraftsCore,
  extractResidueNodes as extractResidueNodesCore,
  readReviewFiles,
  readStatusFiles,
  validateCloseState as validateCloseStateCore,
} from "./close/state";
import { ensureOrchestratorBinary } from "./rust-runtime";

export { resolveStateBackend };
export const buildCleanupPlan = buildCleanupPlanCore;
export const buildCleanupTargets = buildCleanupTargetsCore;
export const buildManagedWorktreeArchiveTargets = buildManagedWorktreeArchiveTargetsCore;
export const buildManagedWorktreeDeleteTargets = buildManagedWorktreeDeleteTargetsCore;
export const buildManagedWorktreeResidueSummary = buildManagedWorktreeResidueSummaryCore;
export const parseCleanupPlan = parseCleanupPlanCore;
export const resolveGithubRunContextForClose = resolveGithubRunContextForCloseCore;
export const shouldRunParentIssueSync = shouldRunParentIssueSyncCore;
export const buildFollowupDrafts = buildFollowupDraftsCore;
export const extractResidueNodes = extractResidueNodesCore;
export const validateCloseState = validateCloseStateCore;

function usage(): string {
  return [
    "Usage:",
    "  bun close.ts verify [--repo-root <path>] [--state-backend <github|local>] [--state-dir <path>] [--session-id <value>] --repository <owner/repo> [--base-branch <name>]",
    "  bun close.ts run [--repo-root <path>] [--state-backend <github|local>] [--state-dir <path>] [--session-id <value>] --repository <owner/repo> [--run-issue <number>] [--run-id <id>] [--base-branch <name>] [--followup-output <path>] [--closeout-output <path>] [--cleanup-plan-output <path>] [--skip-parent-issue-sync] [--skip-worktree-classification]",
    "  bun close.ts cleanup-plan [--repo-root <path>] [--state-backend <github|local>] [--state-dir <path>] [--session-id <value>] --repository <owner/repo> [--run-issue <number>] [--run-id <id>] [--cleanup-plan-output <path>]",
    "  bun close.ts cleanup-apply [--repo-root <path>] [--state-backend <github|local>] [--state-dir <path>] [--session-id <value>] [--repository <owner/repo>] [--cleanup-plan-input <path>] [--dry-run]",
    "",
    "Notes:",
    "  - state dir defaults to <repo_parent>/wt/.omta/state/sessions/<session-id>.",
    "  - when --state-dir is omitted, --session-id or ORCHESTRATE_SESSION_ID is required (except cleanup-apply with --cleanup-plan-input).",
    "  - managed worktree root defaults to <repo_parent>/wt and may be overridden with ORCHESTRATE_MANAGED_WORKTREE_ROOT.",
    "  - state-backend defaults to github.",
    "  - both local and github backends read runtime artifacts (state.json, gate-results.json, status/*.json).",
    "  - github backend resolves repository/run identity from github-run-context.json (or explicit CLI overrides) but does not reconstruct task state from Project-v2.",
    "  - run command bounds parent issue sync to state-dir/inputs/execution-plan.json, skips standalone runs with no grouped parent scope, and fails closed on missing execution-plan artifacts or incomplete parent metadata.",
    "  - follow-up drafting targets all residue nodes.",
    "  - cleanup apply is explicit and separated: use cleanup-apply command.",
  ].join("\n");
}

function resolveRuntimeEnv(): NodeJS.ProcessEnv {
  // biome-ignore lint/style/noProcessEnv: close runtime must read live environment variables for CLI-only hints and overrides.
  return process.env;
}

function writeStdout(message: string): void {
  process.stdout.write(`${message}\n`);
}

function parseRepositorySlug(repository: string): { owner: string; repo: string } {
  const value = repository.trim();
  const parts = value.split("/").filter(Boolean);
  if (parts.length !== 2) {
    fail(`invalid repository slug: ${repository}`);
  }
  return { owner: parts[0], repo: parts[1] };
}

function parseCli(argv: string[]): Cli {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }

  const commandRaw = argv[0]?.trim() || "";
  if (
    commandRaw !== "verify" &&
    commandRaw !== "run" &&
    commandRaw !== "cleanup-plan" &&
    commandRaw !== "cleanup-apply"
  ) {
    fail(`unknown command: ${commandRaw}`);
  }

  const flags = new Map<string, string | true>();
  const allowedFlags = new Set([
    "repo-root",
    "state-dir",
    "session-id",
    "state-backend",
    "base-branch",
    "repository",
    "run-issue",
    "run-id",
    "followup-output",
    "closeout-output",
    "cleanup-plan-output",
    "cleanup-plan-input",
    "dry-run",
    "skip-parent-issue-sync",
    "skip-worktree-classification",
  ]);
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i] ?? "";
    if (!token.startsWith("--")) {
      fail(`unexpected positional argument: ${token}`);
    }

    const key = token.slice(2);
    if (!allowedFlags.has(key) && key !== "apply-cleanup") {
      fail(`unknown option: --${key}`);
    }
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      if (
        key === "dry-run" ||
        key === "skip-parent-issue-sync" ||
        key === "skip-worktree-classification"
      ) {
        flags.set(key, true);
        continue;
      }
      if (key === "apply-cleanup") {
        fail("--apply-cleanup is unsupported; use cleanup-apply command");
      }
      fail(`--${key} requires a value`);
    }
    if (key === "apply-cleanup") {
      fail("--apply-cleanup is unsupported; use cleanup-apply command");
    }
    if (
      key === "dry-run" ||
      key === "skip-parent-issue-sync" ||
      key === "skip-worktree-classification"
    ) {
      fail(`--${key} is a boolean flag and does not accept a value`);
      continue;
    }
    flags.set(key, value);
    i += 1;
  }

  const getFlag = (name: string): string => {
    const value = flags.get(name);
    if (value === true) fail(`--${name} requires a value`);
    return typeof value === "string" ? value.trim() : "";
  };

  return {
    command: commandRaw,
    repoRoot: getFlag("repo-root"),
    stateDir: getFlag("state-dir"),
    sessionId: getFlag("session-id"),
    stateBackend: getFlag("state-backend"),
    baseBranch: getFlag("base-branch") || "main",
    skipWorktreeClassification: flags.get("skip-worktree-classification") === true,
    repository: getFlag("repository"),
    runIssue: getFlag("run-issue"),
    runId: getFlag("run-id"),
    followupOutput: getFlag("followup-output"),
    closeoutOutput: getFlag("closeout-output"),
    cleanupPlanOutput: getFlag("cleanup-plan-output"),
    cleanupPlanInput: getFlag("cleanup-plan-input"),
    dryRun: flags.get("dry-run") === true,
    skipParentIssueSync: flags.get("skip-parent-issue-sync") === true,
  };
}

function resolveRepoRoot(value: string): string {
  const override = value.trim();
  if (override) {
    return path.resolve(override);
  }
  const root = run("git", ["rev-parse", "--show-toplevel"], process.cwd()).trim();
  if (!root) {
    fail("failed to resolve repository root");
  }
  return root;
}

export function resolveManagedWorktreeRoot(repoRoot: string): string {
  const override = String(resolveRuntimeEnv()[MANAGED_WORKTREE_ROOT_ENV] || "").trim();
  if (!override) {
    return resolveDefaultWorktreeRoot(repoRoot);
  }
  return path.resolve(repoRoot, override);
}

function resolveSessionId(value: string): string {
  return resolveSharedSessionId(value, {
    envValue: String(resolveRuntimeEnv().ORCHESTRATE_SESSION_ID || "").trim(),
    requiredMessage:
      "--session-id or ORCHESTRATE_SESSION_ID is required when --state-dir is omitted",
  });
}

function resolveRequiredRepository(repository: string): string {
  const text = repository.trim();
  if (!text) {
    fail("--repository is required");
  }
  parseRepositorySlug(text);
  return text;
}

function isManagedWorktreeDirName(name: string): boolean {
  return (
    Boolean(name) &&
    !name.startsWith(".") &&
    !name.startsWith("_") &&
    MANAGED_WORKTREE_DIR_PATTERN.test(name)
  );
}

function readRegisteredWorktreePaths(repoRoot: string): string[] {
  const result = runResult("git", ["worktree", "list", "--porcelain"], repoRoot);
  if (result.status !== 0) {
    const detail = `${result.stderr}\n${result.stdout}`.trim();
    fail(`failed to list registered worktrees: ${detail || `exit=${result.status}`}`);
  }
  return result.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim())
    .filter(Boolean)
    .map((entry) => resolveCanonicalPath(entry));
}

function readGitdirPointer(worktreePath: string): string | undefined {
  const gitPath = path.join(worktreePath, ".git");
  if (!existsSync(gitPath)) return undefined;
  try {
    const raw = readFileSync(gitPath, "utf8");
    const matched = /^gitdir:\s*(.+)$/m.exec(raw);
    return matched?.[1]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function collectTopLevelEntryNames(worktreePath: string): {
  names: string[];
  scanError?: string;
} {
  try {
    return {
      names: readdirSync(worktreePath).sort((left, right) => left.localeCompare(right)),
    };
  } catch (error) {
    return {
      names: [],
      scanError: error instanceof Error ? error.message : String(error),
    };
  }
}

function evaluateBaseWorktreeCleanSummary(repoRoot: string): {
  clean: boolean;
  detail: string;
} {
  const result = runResult("git", ["status", "--porcelain", "-uall"], repoRoot);
  if (result.status !== 0) {
    const detail = `${result.stderr}\n${result.stdout}`.trim();
    return {
      clean: false,
      detail: `git status failed: ${detail || `exit=${result.status}`}`,
    };
  }
  const lines = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
  if (lines.length === 0) {
    return {
      clean: true,
      detail: "clean",
    };
  }
  const preview = lines.slice(0, 5).join(", ");
  const overflow = lines.length - Math.min(lines.length, 5);
  return {
    clean: false,
    detail:
      overflow > 0
        ? `${lines.length} changed path(s): ${preview}, ... (+${overflow} more)`
        : `${lines.length} changed path(s): ${preview}`,
  };
}

function classifyUnregisteredManagedDir(
  worktreePath: string
): RepoSafetyUnregisteredManagedDirClassification {
  const resolved = resolveCanonicalPath(worktreePath);
  const { names, scanError } = collectTopLevelEntryNames(resolved);
  const previewEntries = names.filter((entry) => entry !== ".git");
  const nonEphemeralEntries = previewEntries.filter(
    (entry) => !EPHEMERAL_UNREGISTERED_TOP_LEVEL_NAMES.has(entry)
  );
  const gitEntry = path.join(resolved, ".git");
  const gitProbe = runResult(
    "git",
    ["-C", resolved, "rev-parse", "--is-inside-work-tree"],
    resolved
  );
  const gitRepoValid = gitProbe.status === 0 && gitProbe.stdout.trim() === "true";
  let gitState: RepoSafetyUnregisteredManagedDirGitState = "missing";
  if (gitRepoValid) {
    gitState = "valid";
  } else if (existsSync(gitEntry)) {
    gitState = "invalid";
  }
  const brokenName = path.basename(resolved).includes(BROKEN_WORKTREE_DIR_MARKER);
  let disposition: RepoSafetyUnregisteredManagedDirDisposition = "rescue";
  if (scanError) {
    disposition = "rescue";
  } else if (brokenName || gitState === "invalid") {
    disposition = "broken_archive";
  } else if (!gitRepoValid && nonEphemeralEntries.length === 0) {
    disposition = "delete";
  }

  let reason: RepoSafetyUnregisteredManagedDirReason = "contains_non_ephemeral_entries";
  if (scanError) {
    reason = "scan_error";
  } else if (brokenName) {
    reason = "broken_suffix";
  } else if (gitState === "invalid") {
    reason = "stale_git_metadata";
  } else if (gitRepoValid) {
    reason = "valid_git_repo_not_registered";
  } else if (nonEphemeralEntries.length === 0) {
    reason = "ephemeral_only";
  }

  return {
    worktree: resolved,
    dir_name: path.basename(resolved),
    disposition,
    reason,
    git_state: gitState,
    top_level_entry_count: previewEntries.length,
    top_level_entries_preview: previewEntries.slice(0, UNREGISTERED_DIR_PREVIEW_LIMIT),
    top_level_entries_overflow_count: Math.max(
      0,
      previewEntries.length - UNREGISTERED_DIR_PREVIEW_LIMIT
    ),
    gitdir_target: readGitdirPointer(resolved),
    scan_error: scanError,
  };
}

function summarizeUnregisteredDispositionCounts(
  items: RepoSafetyUnregisteredManagedDirClassification[]
): RepoSafetyUnregisteredManagedDirDispositionCounts {
  return items.reduce(
    (counts, item) => {
      counts[item.disposition] += 1;
      return counts;
    },
    { delete: 0, rescue: 0, broken_archive: 0 }
  );
}

function buildScopedRepoSafetyNextAction(options: {
  baseWorktreeClean: boolean;
  managedWorktreeRoot: string;
  dispositionCounts: RepoSafetyUnregisteredManagedDirDispositionCounts;
  unregisteredManagedDirCount: number;
}): string {
  if (options.unregisteredManagedDirCount > 0) {
    return [
      `Review managed worktree residue under ${options.managedWorktreeRoot}`,
      `delete=${options.dispositionCounts.delete}`,
      `rescue=${options.dispositionCounts.rescue}`,
      `broken_archive=${options.dispositionCounts.broken_archive}`,
    ].join(" | ");
  }
  if (!options.baseWorktreeClean) {
    return "Clean the current close runtime worktree before cleanup apply";
  }
  return "";
}

function inspectScopedRepoSafety(repoRoot: string, baseBranch: string): RepoSafetySummary {
  const resolvedRepoRoot = resolveCanonicalPath(repoRoot);
  const managedWorktreeRoot = resolveManagedWorktreeRoot(resolvedRepoRoot);
  const registeredWorktrees = readRegisteredWorktreePaths(resolvedRepoRoot);
  const registeredWorktreeSet = new Set(registeredWorktrees);
  const managedCandidates = existsSync(managedWorktreeRoot)
    ? readdirSync(managedWorktreeRoot)
        .map((entry) => path.join(managedWorktreeRoot, entry))
        .filter((entry) => {
          const name = path.basename(entry);
          return existsSync(entry) && isManagedWorktreeDirName(name);
        })
        .map((entry) => resolveCanonicalPath(entry))
        .filter((entry) => !registeredWorktreeSet.has(entry))
        .sort((left, right) => left.localeCompare(right))
    : [];
  const classifications = managedCandidates.map((entry) => classifyUnregisteredManagedDir(entry));
  const dispositionCounts = summarizeUnregisteredDispositionCounts(classifications);
  const baseWorktree = evaluateBaseWorktreeCleanSummary(resolvedRepoRoot);
  const blockingReasons: RepoSafetyBlockingReason[] = [];
  if (!baseWorktree.clean) {
    blockingReasons.push({
      code: "base_worktree_dirty",
      detail: baseWorktree.detail,
    });
  }
  if (classifications.length > 0) {
    blockingReasons.push({
      code: "unregistered_worktree_dirs",
      detail: `${classifications.length} managed wt dir(s) are not registered in git metadata`,
    });
  }
  return {
    repo_root: resolvedRepoRoot,
    base_branch: baseBranch,
    managed_worktree_root: managedWorktreeRoot,
    base_worktree_clean: baseWorktree.clean,
    base_worktree_detail: baseWorktree.detail,
    registered_worktree_count: registeredWorktrees.length,
    invalid_worktree_count: 0,
    invalid_worktrees: [],
    unregistered_managed_dir_count: classifications.length,
    unregistered_managed_dirs: classifications.map((entry) => entry.worktree),
    unregistered_managed_dir_disposition_counts: dispositionCounts,
    unregistered_managed_dir_classifications: classifications,
    prunable_worktree_count: 0,
    prunable_worktrees: [],
    blocking_reasons: blockingReasons,
    next_action: buildScopedRepoSafetyNextAction({
      baseWorktreeClean: baseWorktree.clean,
      managedWorktreeRoot,
      dispositionCounts,
      unregisteredManagedDirCount: classifications.length,
    }),
    recommended_phase: blockingReasons.length === 0 ? "execute" : "close",
  };
}

function parseGithubIssueUrl(
  value: string,
  repository: string,
  field: string
): {
  issueNumber: number;
} {
  const text = value.trim();
  const matched = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)(?:[/?#].*)?$/i.exec(
    text
  );
  if (!matched) {
    fail(`${field} must be https://github.com/<owner>/<repo>/issues/<number>`);
  }

  const actualRepository = `${matched[1]}/${matched[2]}`.toLowerCase();
  const expectedRepository = repository.trim().toLowerCase();
  if (actualRepository !== expectedRepository) {
    fail(`${field} must reference https://github.com/${repository}/issues/<number>`);
  }

  return {
    issueNumber: Number(matched[3] || 0),
  };
}

export function resolveParentIssueSyncScopeFromRuntimeArtifacts(options: {
  stateDir: string;
  repository: string;
}): ParentIssueSyncScope {
  const executionPlanPath = path.join(options.stateDir, "inputs", "execution-plan.json");
  const executionPlanArtifact = readSessionExecutionPlanArtifact(options.stateDir);
  if (!executionPlanArtifact) {
    fail(`required file not found: ${executionPlanPath}`);
  }
  const executionPlanRaw = executionPlanArtifact.raw;
  if (!isObject(executionPlanRaw)) {
    fail("inputs/execution-plan.json must be a JSON object");
  }

  const issueTracking = executionPlanRaw.issue_tracking;
  if (!isObject(issueTracking)) {
    fail("inputs/execution-plan.json must include issue_tracking object");
  }

  const trackedRepository = String(issueTracking.repository || "").trim();
  if (!trackedRepository) {
    fail("inputs/execution-plan.json issue_tracking.repository is required");
  }
  if (trackedRepository.toLowerCase() !== options.repository.trim().toLowerCase()) {
    fail(
      `inputs/execution-plan.json issue_tracking.repository must match ${options.repository}: ${trackedRepository}`
    );
  }

  const sourceItems = executionPlanRaw.source_items;
  if (!Array.isArray(sourceItems) || sourceItems.length === 0) {
    fail("inputs/execution-plan.json source_items must be a non-empty array");
  }

  const parentIssueNumbers = new Set<number>();
  for (const [index, sourceItem] of sourceItems.entries()) {
    if (!isObject(sourceItem)) {
      fail(`inputs/execution-plan.json source_items[${index}] must be an object`);
    }

    const hasParentIssueNumberField = Object.hasOwn(sourceItem, "parent_issue_number");
    const hasParentIssueUrlField = Object.hasOwn(sourceItem, "parent_issue_url");
    const parentIssueNumber = Number(sourceItem.parent_issue_number || 0);
    const parentIssueUrl = String(sourceItem.parent_issue_url || "").trim();
    if (!hasParentIssueNumberField && !hasParentIssueUrlField) {
      continue;
    }
    if (hasParentIssueNumberField !== hasParentIssueUrlField) {
      fail(
        `inputs/execution-plan.json source_items[${index}] must set parent_issue_number and parent_issue_url together`
      );
    }
    if (!Number.isInteger(parentIssueNumber) || parentIssueNumber <= 0) {
      fail(
        `inputs/execution-plan.json source_items[${index}].parent_issue_number must be a positive integer`
      );
    }
    if (!parentIssueUrl) {
      fail(`inputs/execution-plan.json source_items[${index}].parent_issue_url is required`);
    }

    const parsedUrl = parseGithubIssueUrl(
      parentIssueUrl,
      options.repository,
      `inputs/execution-plan.json source_items[${index}].parent_issue_url`
    );
    if (parsedUrl.issueNumber !== parentIssueNumber) {
      fail(
        `inputs/execution-plan.json source_items[${index}].parent_issue_url issue number must match parent_issue_number (${parentIssueNumber})`
      );
    }

    parentIssueNumbers.add(parentIssueNumber);
  }

  return {
    executionPlanPath,
    parentIssueNumbers: [...parentIssueNumbers].sort((left, right) => left - right),
  };
}

export function collectInvalidWorktreeClassifications(
  classifications: WorktreeClassification[]
): WorktreeClassification[] {
  return classifications.filter((entry) => entry.group === INVALID_WORKTREE_GROUP);
}

export function buildInvalidWorktreeNextAction(classifications: WorktreeClassification[]): string {
  const invalid = collectInvalidWorktreeClassifications(classifications);
  if (invalid.length === 0) {
    return "";
  }

  const details = invalid
    .slice(0, 3)
    .map((entry) => `${entry.branch} (${entry.merge_reason}) @ ${entry.worktree}`)
    .join(", ");
  const overflow = invalid.length > 3 ? `, +${invalid.length - 3} more` : "";
  return `Repair invalid git worktree metadata before cleanup apply: ${details}${overflow}`;
}

export function buildWorktreeClassificationSummary(
  classifications: WorktreeClassification[]
): WorktreeClassificationSummary {
  const invalidWorktrees = collectInvalidWorktreeClassifications(classifications);
  return {
    invalid_worktree_count: invalidWorktrees.length,
    invalid_worktrees: invalidWorktrees,
    next_action: buildInvalidWorktreeNextAction(classifications),
  };
}

export function inspectRepoSafety(
  repoRoot: string,
  baseBranch: string,
  runner: typeof runResult = runResult,
  command?: string
): RepoSafetySummary {
  if (String(resolveRuntimeEnv()[MANAGED_WORKTREE_ROOT_ENV] || "").trim()) {
    return inspectScopedRepoSafety(repoRoot, baseBranch);
  }
  const resolvedCommand = command || ensureOrchestratorBinary({ repoRoot });
  const result = runner(
    resolvedCommand,
    ["repo-safety", "--repo-root", repoRoot, "--base-branch", baseBranch],
    repoRoot
  );
  if (result.status !== 0) {
    const detail = `${result.stderr}\n${result.stdout}`.trim();
    fail(`repo safety inspection failed: ${detail || `exit=${result.status}`}`);
  }

  try {
    return JSON.parse(result.stdout) as RepoSafetySummary;
  } catch (error) {
    fail(`repo safety inspection returned invalid JSON: ${(error as Error).message}`);
  }
}

function applyCleanupPlan(
  repoRoot: string,
  plan: CleanupPlan,
  options: {
    repositoryOverride: string;
    dryRun: boolean;
  }
): CleanupResult[] {
  const results: CleanupResult[] = [];
  const allowedWorktreeRoot = resolveCanonicalPath(resolveManagedWorktreeRoot(repoRoot));
  const managedDeleteTargets = plan.targets.filter(
    (target): target is ManagedWorktreeDeleteTarget => target.kind === "managed_worktree_delete"
  );
  const managedArchiveTargets = plan.targets.filter(
    (target): target is ManagedWorktreeArchiveTarget => target.kind === "managed_worktree_archive"
  );
  let managedClassification = new Map<string, RepoSafetyUnregisteredManagedDirClassification>();
  if (managedDeleteTargets.length > 0 || managedArchiveTargets.length > 0) {
    const repoSafety = inspectRepoSafety(repoRoot, plan.base_branch);
    managedClassification = new Map(
      repoSafety.unregistered_managed_dir_classifications.map((entry) => [
        resolveCanonicalPath(entry.worktree),
        entry,
      ])
    );
  }

  for (const target of plan.targets) {
    if (target.kind === "managed_worktree_delete") {
      const worktreePath = resolveCanonicalPath(target.worktree_path);
      if (!pathIsWithin(worktreePath, allowedWorktreeRoot)) {
        results.push({
          kind: target.kind,
          target_id: target.target_id,
          task_id: target.target_id,
          pr: "",
          worktree_path: worktreePath,
          ok: false,
          detail: `managed worktree delete target is outside allowed wt root: ${worktreePath}`,
        });
        continue;
      }
      const currentClassification = managedClassification.get(worktreePath);
      if (!currentClassification || currentClassification.disposition !== "delete") {
        results.push({
          kind: target.kind,
          target_id: target.target_id,
          task_id: target.target_id,
          pr: "",
          worktree_path: worktreePath,
          ok: false,
          detail: `managed worktree delete target is no longer classified as delete: ${worktreePath}`,
        });
        continue;
      }
      if (
        currentClassification.dir_name !== target.target_id ||
        currentClassification.reason !== target.reason
      ) {
        results.push({
          kind: target.kind,
          target_id: target.target_id,
          task_id: target.target_id,
          pr: "",
          worktree_path: worktreePath,
          ok: false,
          detail: `managed worktree delete target drifted since plan generation: ${worktreePath}`,
        });
        continue;
      }
      if (!existsSync(worktreePath)) {
        results.push({
          kind: target.kind,
          target_id: target.target_id,
          task_id: target.target_id,
          pr: "",
          worktree_path: worktreePath,
          ok: false,
          detail: `managed worktree delete target no longer exists: ${worktreePath}`,
        });
        continue;
      }

      if (!options.dryRun) {
        rmSync(worktreePath, { recursive: true, force: false });
      }
      results.push({
        kind: target.kind,
        target_id: target.target_id,
        task_id: target.target_id,
        pr: "",
        worktree_path: worktreePath,
        ok: true,
        detail: options.dryRun ? "planned(delete-managed-worktree --dry-run)" : "deleted",
      });
      continue;
    }

    if (target.kind === "managed_worktree_archive") {
      const worktreePath = resolveCanonicalPath(target.worktree_path);
      if (!pathIsWithin(worktreePath, allowedWorktreeRoot)) {
        results.push({
          kind: target.kind,
          target_id: target.target_id,
          task_id: target.target_id,
          pr: "",
          worktree_path: worktreePath,
          ok: false,
          detail: `managed worktree archive target is outside allowed wt root: ${worktreePath}`,
        });
        continue;
      }
      const currentClassification = managedClassification.get(worktreePath);
      if (!currentClassification || currentClassification.disposition !== target.disposition) {
        results.push({
          kind: target.kind,
          target_id: target.target_id,
          task_id: target.target_id,
          pr: "",
          worktree_path: worktreePath,
          ok: false,
          detail: `managed worktree archive target is no longer classified as ${target.disposition}: ${worktreePath}`,
        });
        continue;
      }
      if (
        currentClassification.dir_name !== target.target_id ||
        currentClassification.reason !== target.reason
      ) {
        results.push({
          kind: target.kind,
          target_id: target.target_id,
          task_id: target.target_id,
          pr: "",
          worktree_path: worktreePath,
          ok: false,
          detail: `managed worktree archive target drifted since plan generation: ${worktreePath}`,
        });
        continue;
      }
      if (!existsSync(worktreePath)) {
        results.push({
          kind: target.kind,
          target_id: target.target_id,
          task_id: target.target_id,
          pr: "",
          worktree_path: worktreePath,
          ok: false,
          detail: `managed worktree archive target no longer exists: ${worktreePath}`,
        });
        continue;
      }

      const archivePath = path.join(
        allowedWorktreeRoot,
        ".omta",
        "archive",
        "managed-worktree-residue",
        plan.plan_id,
        target.disposition,
        target.target_id
      );
      if (!pathIsWithin(archivePath, path.join(allowedWorktreeRoot, ".omta"))) {
        results.push({
          kind: target.kind,
          target_id: target.target_id,
          task_id: target.target_id,
          pr: "",
          worktree_path: worktreePath,
          archive_path: archivePath,
          ok: false,
          detail: `managed worktree archive destination escaped archive root: ${archivePath}`,
        });
        continue;
      }
      if (existsSync(archivePath)) {
        results.push({
          kind: target.kind,
          target_id: target.target_id,
          task_id: target.target_id,
          pr: "",
          worktree_path: worktreePath,
          archive_path: archivePath,
          ok: false,
          detail: `managed worktree archive destination already exists: ${archivePath}`,
        });
        continue;
      }

      if (!options.dryRun) {
        mkdirSync(path.dirname(archivePath), { recursive: true });
        renameSync(worktreePath, archivePath);
      }
      results.push({
        kind: target.kind,
        target_id: target.target_id,
        task_id: target.target_id,
        pr: "",
        worktree_path: worktreePath,
        archive_path: archivePath,
        ok: true,
        detail: options.dryRun ? "planned(archive-managed-worktree --dry-run)" : "archived",
      });
      continue;
    }

    const args = ["run", "pr:cleanup", "--", "--pr", target.pr];
    const repository = options.repositoryOverride.trim() || plan.repository.trim();
    if (repository) {
      args.push("--repository", repository);
    }
    if (options.dryRun) {
      args.push("--dry-run");
    }

    const result = runResult("bun", args, repoRoot);
    const ok = result.status === 0;
    let detail: string;
    if (!ok) {
      detail = `${result.stderr}\n${result.stdout}`.trim() || `exit=${result.status}`;
    } else if (options.dryRun) {
      detail = "planned(--dry-run)";
    } else {
      detail = "cleaned";
    }
    results.push({
      kind: target.kind,
      target_id: target.task_id,
      task_id: target.task_id,
      pr: target.pr,
      worktree_path: "",
      ok,
      detail,
    });
  }
  return results;
}

function resolveCleanupPlanOutputPath(cli: Cli, stateDir: string): string {
  return resolveOutputPath(
    cli.cleanupPlanOutput,
    resolveSessionArtifactPaths(stateDir).cleanupPlanJson
  );
}

function resolveCleanupPlanInputPath(cli: Cli, stateDir: string): string {
  return resolveOutputPath(
    cli.cleanupPlanInput,
    resolveSessionArtifactPaths(stateDir).cleanupPlanJson
  );
}

function main(): void {
  const cli = parseCli(process.argv.slice(2));
  const repoRoot = resolveRepoRoot(cli.repoRoot);
  const stateBackend = resolveStateBackend(cli.stateBackend);
  let stateDirRaw = cli.stateDir ? path.resolve(cli.stateDir) : "";
  if (!stateDirRaw && cli.command === "cleanup-apply" && cli.cleanupPlanInput.trim()) {
    stateDirRaw = path.dirname(path.resolve(cli.cleanupPlanInput));
  }
  if (!stateDirRaw) {
    const sessionId = resolveSessionId(cli.sessionId);
    stateDirRaw = resolveStateDirForSession(repoRoot, sessionId);
  }
  const stateDir = enforceStateDirPolicy(repoRoot, stateDirRaw);
  const artifactPaths = resolveSessionArtifactPaths(stateDir);
  const manifestSessionId = cli.sessionId.trim() || path.basename(stateDir);
  if (cli.dryRun && cli.command !== "cleanup-apply") {
    fail("--dry-run is only supported for cleanup-apply");
  }
  runCloseCommandWithLifecycle({
    stateDir,
    sessionId: manifestSessionId,
    command: cli.command,
    run: () => {
      if (cli.command === "cleanup-apply") {
        const cleanupPlanPath = resolveCleanupPlanInputPath(cli, stateDir);
        const cleanupPlan = parseCleanupPlan(readJsonFile(cleanupPlanPath));
        const cleanup = applyCleanupPlan(repoRoot, cleanupPlan, {
          repositoryOverride: cli.repository,
          dryRun: cli.dryRun,
        });
        const cleanupFailures = cleanup.filter((entry) => !entry.ok);
        if (cleanupFailures.length > 0) {
          const detail = cleanupFailures.map((entry) => describeCleanupFailure(entry)).join("\n- ");
          fail(`cleanup apply failed:\n- ${detail}`);
        }
        const summaryPath = resolveOutputPath(
          cli.closeoutOutput,
          artifactPaths.cleanupApplySummaryJson
        );
        writeJsonFile(
          summaryPath,
          buildCleanupApplySummary({
            cleanupPlan,
            cleanupPlanPath,
            repository: cli.repository.trim() || cleanupPlan.repository,
            cleanup,
            dryRun: cli.dryRun,
          })
        );
        emitSessionManifest({
          stateDir,
          sessionId: manifestSessionId,
          stateBackend: cleanupPlan.state_backend,
          repository: cli.repository.trim() || cleanupPlan.repository,
          command: "close:cleanup-apply",
          fileOverride: {
            cleanupPlanJson: cleanupPlanPath,
            cleanupApplySummaryJson: summaryPath,
          },
        });
        appendCloseRuntimeEvent({
          stateDir,
          sessionId: manifestSessionId,
          eventType: "close.cleanup_apply.completed",
          payload: {
            cleanup_count: cleanup.length,
            dry_run: cli.dryRun,
            summary_path: summaryPath,
          },
        });
        writeStdout(
          [
            "cleanup apply completed",
            `plan=${cleanupPlanPath}`,
            `count=${cleanup.length}`,
            `dry_run=${cli.dryRun ? "true" : "false"}`,
            `summary=${summaryPath}`,
          ].join(" | ")
        );
        return;
      }

      const decisionArtifacts = readSessionDecisionPayloadSnapshot(stateDir);
      const state = decisionArtifacts.state_payload;
      const gate = decisionArtifacts.gate_results;

      const githubRunContext = resolveGithubRunContextForClose({
        cliRepository: cli.repository,
        cliRunId: cli.runId,
        cliRunIssue: cli.runIssue,
        stateBackend,
        stateDir,
      });
      const resolvedRepository = resolveRequiredRepository(githubRunContext.repository);
      const runIssueNumber = githubRunContext.runIssueNumber;
      const runId = githubRunContext.runId;

      const statusFiles = readStatusFiles(stateDir);
      const reviewFiles = readReviewFiles(stateDir);
      const validationErrors = validateCloseState(state, gate, {
        requireBranch: true,
      });
      if (validationErrors.length > 0) {
        fail(`close verification failed:\n- ${validationErrors.join("\n- ")}`);
      }

      const residues = extractResidueNodes(state, gate, statusFiles, reviewFiles);

      if (cli.command === "verify") {
        const closeoutPath = resolveOutputPath(
          cli.closeoutOutput,
          artifactPaths.closeoutSummaryJson
        );
        writeJsonFile(
          closeoutPath,
          buildVerifyCloseoutSummary({
            stateDir,
            stateBackend,
            nodeCount: Object.keys(state.nodes).length,
            residues,
          })
        );
        emitSessionManifest({
          stateDir,
          sessionId: manifestSessionId,
          stateBackend,
          repository: resolvedRepository,
          command: "close:verify",
          fileOverride: {
            closeoutSummaryJson: closeoutPath,
          },
        });
        appendCloseRuntimeEvent({
          stateDir,
          sessionId: manifestSessionId,
          eventType: "close.verify.completed",
          payload: {
            node_count: Object.keys(state.nodes).length,
            residue_count: residues.length,
            closeout_path: closeoutPath,
          },
        });
        writeStdout(
          `close verify passed | state_dir=${stateDir} | nodes=${Object.keys(state.nodes).length} | residue=${residues.length}`
        );
        return;
      }

      const repoSafety = inspectRepoSafety(repoRoot, cli.baseBranch);
      const managedWorktreeResidue = buildManagedWorktreeResidueSummary(repoSafety);
      const repoSafetyPath = artifactPaths.repoSafetyJson;
      const managedWorktreeResiduePath = artifactPaths.managedWorktreeResidueJson;
      const cleanupPlan = buildCleanupPlan({
        state,
        gate,
        stateBackend,
        repository: resolvedRepository,
        runIssueNumber,
        runId,
        baseBranch: cli.baseBranch,
        repoSafety,
      });
      const cleanupPlanPath = resolveCleanupPlanOutputPath(cli, stateDir);
      writeJsonFile(cleanupPlanPath, cleanupPlan);
      appendCloseRuntimeEvent({
        stateDir,
        sessionId: manifestSessionId,
        eventType: "close.cleanup_plan.persisted",
        payload: {
          cleanup_plan_id: cleanupPlan.plan_id,
          cleanup_target_count: cleanupPlan.target_count,
          cleanup_plan_path: cleanupPlanPath,
        },
      });
      writeJsonFile(repoSafetyPath, repoSafety);
      writeJsonFile(managedWorktreeResiduePath, managedWorktreeResidue);
      appendCloseRuntimeEvent({
        stateDir,
        sessionId: manifestSessionId,
        eventType: "close.managed_worktree_residue.generated",
        payload: {
          output_path: managedWorktreeResiduePath,
          unregistered_managed_dir_count: repoSafety.unregistered_managed_dir_count,
          disposition_counts: repoSafety.unregistered_managed_dir_disposition_counts,
        },
      });

      if (cli.command === "cleanup-plan") {
        const summaryPath = resolveOutputPath(
          cli.closeoutOutput,
          artifactPaths.cleanupPlanSummaryJson
        );
        writeJsonFile(
          summaryPath,
          buildCleanupPlanSummary({
            stateDir,
            stateBackend,
            repository: resolvedRepository,
            runIssueNumber,
            runId,
            cleanupPlan,
            cleanupPlanPath,
            repoSafetyPath,
            managedWorktreeResiduePath,
          })
        );
        emitSessionManifest({
          stateDir,
          sessionId: manifestSessionId,
          stateBackend,
          repository: resolvedRepository,
          command: "close:cleanup-plan",
          fileOverride: {
            repoSafetyJson: repoSafetyPath,
            managedWorktreeResidueJson: managedWorktreeResiduePath,
            cleanupPlanJson: cleanupPlanPath,
            cleanupPlanSummaryJson: summaryPath,
          },
        });
        appendCloseRuntimeEvent({
          stateDir,
          sessionId: manifestSessionId,
          eventType: "close.cleanup_plan.completed",
          payload: {
            cleanup_plan_id: cleanupPlan.plan_id,
            cleanup_target_count: cleanupPlan.target_count,
            summary_path: summaryPath,
          },
        });
        writeStdout(
          [
            "cleanup plan generated",
            `state_dir=${stateDir}`,
            `targets=${cleanupPlan.target_count}`,
            `plan=${cleanupPlanPath}`,
            `summary=${summaryPath}`,
          ].join(" | ")
        );
        return;
      }

      // Close already has the canonical invalid-worktree view from repo-safety.
      // Re-running full worktree classification here only duplicates the same Rust scan
      // and makes the close path slower without adding new close-owned state.
      const classifications = cli.skipWorktreeClassification
        ? []
        : [...repoSafety.invalid_worktrees];
      const worktreeSummary = buildWorktreeClassificationSummary(classifications);
      const cleanup: CleanupResult[] = cleanupPlan.targets.map((target) =>
        buildPlannedCleanupResult(target)
      );

      const followupPath = resolveOutputPath(cli.followupOutput, artifactPaths.followupDraftsJson);
      const followupResidues = residues;
      const skippedFollowupResidues: ResidueItem[] = [];
      if (followupResidues.length > 0) {
        writeJsonFile(followupPath, buildFollowupDrafts(followupResidues));
        appendCloseRuntimeEvent({
          stateDir,
          sessionId: manifestSessionId,
          eventType: "close.followup_drafts.generated",
          payload: {
            residue_count: followupResidues.length,
            followup_path: followupPath,
          },
        });
      }

      const closeoutPath = resolveOutputPath(cli.closeoutOutput, artifactPaths.closeoutSummaryJson);
      const nextActions = buildCloseRunNextActions({
        followupPath,
        followupResidues,
        worktreeSummary,
        repoSafety,
        managedWorktreeResiduePath,
        cleanup,
        cleanupPlanPath,
      });

      let parentIssueSync: JsonObject = {};
      if (shouldRunParentIssueSync(stateBackend, cli.skipParentIssueSync)) {
        const parentIssueSyncScope = resolveParentIssueSyncScopeFromRuntimeArtifacts({
          stateDir,
          repository: resolvedRepository,
        });
        parentIssueSync = syncParentIssueStatus({
          repoRoot,
          repository: resolvedRepository,
          stateDir,
          apply: true,
          parentIssueSyncScope,
        });
        appendCloseRuntimeEvent({
          stateDir,
          sessionId: manifestSessionId,
          eventType: "close.parent_issue_sync.completed",
          payload: {
            output_path: String(parentIssueSync.output_path || "").trim(),
            parent_issue_count: parentIssueSyncScope.parentIssueNumbers.length,
          },
        });
      }

      writeJsonFile(
        closeoutPath,
        buildCloseRunSummary({
          stateDir,
          stateBackend,
          repository: resolvedRepository,
          nodeCount: Object.keys(state.nodes).length,
          residues,
          followupResidues,
          skippedFollowupResidues,
          cleanupPlanPath,
          cleanupPlan,
          cleanup,
          parentIssueSync,
          repoSafety,
          managedWorktreeResiduePath,
          managedWorktreeResidue,
          classifications,
          worktreeSummary,
          followupOutput: followupResidues.length > 0 ? followupPath : "",
          nextActions,
        })
      );
      emitSessionManifest({
        stateDir,
        sessionId: manifestSessionId,
        stateBackend,
        repository: resolvedRepository,
        command: "close:run",
        fileOverride: {
          repoSafetyJson: repoSafetyPath,
          managedWorktreeResidueJson: managedWorktreeResiduePath,
          cleanupPlanJson: cleanupPlanPath,
          followupDraftsJson: followupPath,
          closeoutSummaryJson: closeoutPath,
          parentIssueSyncJson: isObject(parentIssueSync)
            ? String(parentIssueSync.output_path || "").trim() || undefined
            : undefined,
        },
      });
      appendCloseRuntimeEvent({
        stateDir,
        sessionId: manifestSessionId,
        eventType: "close.run.completed",
        payload: {
          node_count: Object.keys(state.nodes).length,
          residue_count: residues.length,
          cleanup_count: cleanup.length,
          closeout_path: closeoutPath,
        },
      });

      writeStdout(
        [
          "close run completed",
          `state_dir=${stateDir}`,
          `nodes=${Object.keys(state.nodes).length}`,
          `residue=${residues.length}`,
          `cleanup=${cleanup.length}`,
          `closeout=${closeoutPath}`,
        ].join(" | ")
      );
    },
  });
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`close failed: ${(error as Error).message}\n`);
    process.exit(1);
  }
}
