import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { StateBackend } from "./runtime_policy";
import { EVENT_LOG_FILENAME, SESSION_LOCK_FILENAME } from "./shared_runtime";

export const SESSION_ARTIFACT_SCHEMA_VERSION = 9 as const;
export const SESSION_MANIFEST_FILENAME = "session-manifest.json";
export const CHILD_EXEC_DIRECTORY_NAME = "child-exec";

export type SessionArtifactPaths = {
  stateDir: string;
  manifestJson: string;
  inputsDir: string;
  executionPlanJson: string;
  stateJson: string;
  gateResultsJson: string;
  githubRunContextJson: string;
  sessionLockJson: string;
  eventLogNdjson: string;
  mergeQueueJson: string;
  tasksDir: string;
  statusDir: string;
  reviewDir: string;
  conflictDir: string;
  childExecDir: string;
  cleanupPlanJson: string;
  cleanupPlanSummaryJson: string;
  cleanupApplySummaryJson: string;
  repoSafetyJson: string;
  managedWorktreeResidueJson: string;
  followupDraftsJson: string;
  closeoutSummaryJson: string;
  parentIssueSyncJson: string;
};

export type SessionArtifactManifest = {
  schema_version: typeof SESSION_ARTIFACT_SCHEMA_VERSION;
  generated_at: string;
  command: string;
  session_id: string;
  state_backend: StateBackend;
  repository: string;
  state_dir: string;
  directories: {
    inputs: string;
    tasks: string;
    status: string;
    review: string;
    conflict: string;
    child_exec: string;
  };
  files: {
    session_manifest_json: string;
    execution_plan_json: string;
    state_json: string;
    gate_results_json: string;
    github_run_context_json: string;
    session_lock_json: string;
    event_log_ndjson: string;
    merge_queue_json: string;
    cleanup_plan_json: string;
    cleanup_plan_summary_json: string;
    cleanup_apply_summary_json: string;
    repo_safety_json: string;
    managed_worktree_residue_json: string;
    followup_drafts_json: string;
    closeout_summary_json: string;
    parent_issue_sync_json: string;
  };
  present_directories: string[];
  present_files: string[];
};

export const SESSION_ARTIFACT_PRESENCE_FILE_KEYS = [
  "manifestJson",
  "executionPlanJson",
  "stateJson",
  "gateResultsJson",
  "githubRunContextJson",
  "cleanupPlanJson",
  "cleanupPlanSummaryJson",
  "cleanupApplySummaryJson",
  "followupDraftsJson",
  "closeoutSummaryJson",
  "parentIssueSyncJson",
] as const satisfies readonly (keyof SessionArtifactPaths)[];

export const SESSION_ARTIFACT_PRESENCE_DIRECTORY_KEYS = [
  "inputsDir",
  "tasksDir",
  "statusDir",
  "reviewDir",
  "conflictDir",
  "childExecDir",
] as const satisfies readonly (keyof SessionArtifactPaths)[];

type SessionArtifactFileOverride = Partial<{
  manifestJson: string;
  executionPlanJson: string;
  stateJson: string;
  gateResultsJson: string;
  githubRunContextJson: string;
  sessionLockJson: string;
  eventLogNdjson: string;
  mergeQueueJson: string;
  cleanupPlanJson: string;
  cleanupPlanSummaryJson: string;
  cleanupApplySummaryJson: string;
  repoSafetyJson: string;
  managedWorktreeResidueJson: string;
  followupDraftsJson: string;
  closeoutSummaryJson: string;
  parentIssueSyncJson: string;
}>;

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function toRelative(stateDir: string, absolutePath: string): string {
  return normalizeRelativePath(path.relative(stateDir, absolutePath));
}

function presentEntries(
  stateDir: string,
  candidates: Record<string, string>,
  kind: "file" | "dir"
): string[] {
  return Object.values(candidates)
    .filter((candidate) => {
      const resolved = path.resolve(stateDir, candidate);
      if (!existsSync(resolved)) return false;
      const entry = statSync(resolved);
      return kind === "dir" ? entry.isDirectory() : entry.isFile();
    })
    .map((candidate) => normalizeRelativePath(candidate))
    .sort();
}

export function resolveSessionArtifactPaths(stateDir: string): SessionArtifactPaths {
  const root = path.resolve(stateDir);
  const inputsDir = path.join(root, "inputs");
  const tasksDir = path.join(root, "tasks");
  const statusDir = path.join(root, "status");
  const reviewDir = path.join(root, "review");
  const conflictDir = path.join(root, "conflict");
  const childExecDir = path.join(root, CHILD_EXEC_DIRECTORY_NAME);

  return {
    stateDir: root,
    manifestJson: path.join(root, SESSION_MANIFEST_FILENAME),
    inputsDir,
    executionPlanJson: path.join(inputsDir, "execution-plan.json"),
    stateJson: path.join(root, "state.json"),
    gateResultsJson: path.join(root, "gate-results.json"),
    githubRunContextJson: path.join(root, "github-run-context.json"),
    sessionLockJson: path.join(root, SESSION_LOCK_FILENAME),
    eventLogNdjson: path.join(root, EVENT_LOG_FILENAME),
    mergeQueueJson: path.join(root, "merge-queue.json"),
    tasksDir,
    statusDir,
    reviewDir,
    conflictDir,
    childExecDir,
    cleanupPlanJson: path.join(root, "cleanup-plan.json"),
    cleanupPlanSummaryJson: path.join(root, "cleanup-plan-summary.json"),
    cleanupApplySummaryJson: path.join(root, "cleanup-apply-summary.json"),
    repoSafetyJson: path.join(root, "repo-safety.json"),
    managedWorktreeResidueJson: path.join(root, "managed-worktree-residue.json"),
    followupDraftsJson: path.join(root, "followup-drafts.json"),
    closeoutSummaryJson: path.join(root, "closeout-summary.json"),
    parentIssueSyncJson: path.join(root, "parent-issue-sync.json"),
  };
}

export function buildSessionArtifactManifest(options: {
  stateDir: string;
  sessionId: string;
  stateBackend: StateBackend;
  repository: string;
  command: string;
  generatedAt?: string;
  fileOverride?: SessionArtifactFileOverride;
}): SessionArtifactManifest {
  const paths = resolveSessionArtifactPaths(options.stateDir);
  const filesAbsolute = {
    manifestJson: options.fileOverride?.manifestJson || paths.manifestJson,
    executionPlanJson: options.fileOverride?.executionPlanJson || paths.executionPlanJson,
    stateJson: options.fileOverride?.stateJson || paths.stateJson,
    gateResultsJson: options.fileOverride?.gateResultsJson || paths.gateResultsJson,
    githubRunContextJson: options.fileOverride?.githubRunContextJson || paths.githubRunContextJson,
    sessionLockJson: options.fileOverride?.sessionLockJson || paths.sessionLockJson,
    eventLogNdjson: options.fileOverride?.eventLogNdjson || paths.eventLogNdjson,
    mergeQueueJson: options.fileOverride?.mergeQueueJson || paths.mergeQueueJson,
    cleanupPlanJson: options.fileOverride?.cleanupPlanJson || paths.cleanupPlanJson,
    cleanupPlanSummaryJson:
      options.fileOverride?.cleanupPlanSummaryJson || paths.cleanupPlanSummaryJson,
    cleanupApplySummaryJson:
      options.fileOverride?.cleanupApplySummaryJson || paths.cleanupApplySummaryJson,
    repoSafetyJson: options.fileOverride?.repoSafetyJson || paths.repoSafetyJson,
    managedWorktreeResidueJson:
      options.fileOverride?.managedWorktreeResidueJson || paths.managedWorktreeResidueJson,
    followupDraftsJson: options.fileOverride?.followupDraftsJson || paths.followupDraftsJson,
    closeoutSummaryJson: options.fileOverride?.closeoutSummaryJson || paths.closeoutSummaryJson,
    parentIssueSyncJson: options.fileOverride?.parentIssueSyncJson || paths.parentIssueSyncJson,
  };
  const directories = {
    inputs: toRelative(paths.stateDir, paths.inputsDir),
    tasks: toRelative(paths.stateDir, paths.tasksDir),
    status: toRelative(paths.stateDir, paths.statusDir),
    review: toRelative(paths.stateDir, paths.reviewDir),
    conflict: toRelative(paths.stateDir, paths.conflictDir),
    child_exec: toRelative(paths.stateDir, paths.childExecDir),
  };
  const files = {
    session_manifest_json: toRelative(paths.stateDir, filesAbsolute.manifestJson),
    execution_plan_json: toRelative(paths.stateDir, filesAbsolute.executionPlanJson),
    state_json: toRelative(paths.stateDir, filesAbsolute.stateJson),
    gate_results_json: toRelative(paths.stateDir, filesAbsolute.gateResultsJson),
    github_run_context_json: toRelative(paths.stateDir, filesAbsolute.githubRunContextJson),
    session_lock_json: toRelative(paths.stateDir, filesAbsolute.sessionLockJson),
    event_log_ndjson: toRelative(paths.stateDir, filesAbsolute.eventLogNdjson),
    merge_queue_json: toRelative(paths.stateDir, filesAbsolute.mergeQueueJson),
    cleanup_plan_json: toRelative(paths.stateDir, filesAbsolute.cleanupPlanJson),
    cleanup_plan_summary_json: toRelative(paths.stateDir, filesAbsolute.cleanupPlanSummaryJson),
    cleanup_apply_summary_json: toRelative(paths.stateDir, filesAbsolute.cleanupApplySummaryJson),
    repo_safety_json: toRelative(paths.stateDir, filesAbsolute.repoSafetyJson),
    managed_worktree_residue_json: toRelative(
      paths.stateDir,
      filesAbsolute.managedWorktreeResidueJson
    ),
    followup_drafts_json: toRelative(paths.stateDir, filesAbsolute.followupDraftsJson),
    closeout_summary_json: toRelative(paths.stateDir, filesAbsolute.closeoutSummaryJson),
    parent_issue_sync_json: toRelative(paths.stateDir, filesAbsolute.parentIssueSyncJson),
  };

  return {
    schema_version: SESSION_ARTIFACT_SCHEMA_VERSION,
    generated_at: options.generatedAt || new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    command: options.command,
    session_id: options.sessionId,
    state_backend: options.stateBackend,
    repository: options.repository,
    state_dir: paths.stateDir,
    directories,
    files,
    present_directories: presentEntries(paths.stateDir, directories, "dir"),
    present_files: presentEntries(paths.stateDir, files, "file"),
  };
}

export function writeSessionArtifactManifest(options: {
  stateDir: string;
  sessionId: string;
  stateBackend: StateBackend;
  repository: string;
  command: string;
  generatedAt?: string;
  fileOverride?: SessionArtifactFileOverride;
}): string {
  const manifest = buildSessionArtifactManifest(options);
  const paths = resolveSessionArtifactPaths(options.stateDir);
  mkdirSync(paths.stateDir, { recursive: true });
  writeFileSync(paths.manifestJson, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return paths.manifestJson;
}
