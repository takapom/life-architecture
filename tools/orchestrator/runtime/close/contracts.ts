import type { SessionGateResultsPayload, SessionStatePayload } from "../../shared/session_state";

export type JsonObject = Record<string, unknown>;

export type Command = "verify" | "run" | "cleanup-plan" | "cleanup-apply";

export type Cli = {
  command: Command;
  repoRoot: string;
  stateDir: string;
  sessionId: string;
  stateBackend: string;
  baseBranch: string;
  skipWorktreeClassification: boolean;
  repository: string;
  runIssue: string;
  runId: string;
  followupOutput: string;
  closeoutOutput: string;
  cleanupPlanOutput: string;
  cleanupPlanInput: string;
  dryRun: boolean;
  skipParentIssueSync: boolean;
};

export type ResidueItem = {
  node_id: string;
  status: string;
  branch: string;
  summary: string;
  failure_reason: string;
  pr_url: string;
  review_decision: string;
  review_summary: string;
  review_findings: ReviewFinding[];
  review_escalation: {
    level: string;
    reason: string;
  };
};

export type ReviewFinding = {
  severity: string;
  category: string;
  summary: string;
  path?: string;
  line?: number;
};

export type ReviewArtifact = {
  decision: string;
  summary: string;
  findings: ReviewFinding[];
  escalation: {
    level: string;
    reason: string;
  };
};

export type CleanupPlanTargetKind =
  | "pr_cleanup"
  | "managed_worktree_delete"
  | "managed_worktree_archive";

export type CleanupResult = {
  kind: CleanupPlanTargetKind;
  target_id: string;
  task_id: string;
  pr: string;
  worktree_path: string;
  archive_path?: string;
  ok: boolean;
  detail: string;
};

export type CleanupPrTarget = {
  kind: "pr_cleanup";
  task_id: string;
  pr: string;
};

export type ManagedWorktreeDeleteTarget = {
  kind: "managed_worktree_delete";
  target_id: string;
  worktree_path: string;
  disposition: "delete";
  reason: string;
};

export type ManagedWorktreeArchiveTarget = {
  kind: "managed_worktree_archive";
  target_id: string;
  worktree_path: string;
  disposition: "rescue" | "broken_archive";
  reason: string;
};

export type CleanupPlanTarget =
  | CleanupPrTarget
  | ManagedWorktreeDeleteTarget
  | ManagedWorktreeArchiveTarget;

export type CleanupPlan = {
  cleanup_plan_version: 1;
  generated_at: string;
  plan_id: string;
  state_backend: "github" | "local";
  repository: string;
  base_branch: string;
  run_issue_number: number;
  run_id: string;
  target_count: number;
  pr_target_count: number;
  managed_worktree_delete_target_count: number;
  managed_worktree_archive_target_count: number;
  managed_worktree_archive_disposition_counts: {
    rescue: number;
    broken_archive: number;
  };
  targets: CleanupPlanTarget[];
};

export type WorktreeClassification = {
  group: string;
  branch: string;
  ahead: number;
  behind: number;
  worktree: string;
  merge_reason: string;
};

export type WorktreeClassificationSummary = {
  invalid_worktree_count: number;
  invalid_worktrees: WorktreeClassification[];
  next_action: string;
};

export type RepoSafetyBlockingReason = {
  code: string;
  detail: string;
};

export type RepoSafetyUnregisteredManagedDirDisposition = "delete" | "rescue" | "broken_archive";

export type RepoSafetyUnregisteredManagedDirGitState = "valid" | "invalid" | "missing";

export type RepoSafetyUnregisteredManagedDirReason =
  | "scan_error"
  | "broken_suffix"
  | "stale_git_metadata"
  | "valid_git_repo_not_registered"
  | "ephemeral_only"
  | "contains_non_ephemeral_entries";

export type RepoSafetyUnregisteredManagedDirClassification = {
  worktree: string;
  dir_name: string;
  disposition: RepoSafetyUnregisteredManagedDirDisposition;
  reason: RepoSafetyUnregisteredManagedDirReason | string;
  git_state: RepoSafetyUnregisteredManagedDirGitState | string;
  top_level_entry_count: number;
  top_level_entries_preview: string[];
  top_level_entries_overflow_count: number;
  gitdir_target?: string;
  scan_error?: string;
};

export type RepoSafetyUnregisteredManagedDirDispositionCounts = {
  delete: number;
  rescue: number;
  broken_archive: number;
};

export type RepoSafetySummary = {
  repo_root: string;
  base_branch: string;
  managed_worktree_root: string;
  base_worktree_clean: boolean;
  base_worktree_detail: string;
  registered_worktree_count: number;
  invalid_worktree_count: number;
  invalid_worktrees: WorktreeClassification[];
  unregistered_managed_dir_count: number;
  unregistered_managed_dirs: string[];
  unregistered_managed_dir_disposition_counts: RepoSafetyUnregisteredManagedDirDispositionCounts;
  unregistered_managed_dir_classifications: RepoSafetyUnregisteredManagedDirClassification[];
  prunable_worktree_count: number;
  prunable_worktrees: Array<{ worktree: string; detail: string }>;
  blocking_reasons: RepoSafetyBlockingReason[];
  next_action: string;
  recommended_phase: string;
};

export type ManagedWorktreeResidueSummary = {
  generated_at: string;
  managed_worktree_root: string;
  unregistered_managed_dir_count: number;
  disposition_counts: RepoSafetyUnregisteredManagedDirDispositionCounts;
  items: RepoSafetyUnregisteredManagedDirClassification[];
  next_action: string;
};

export type ParentIssueSyncScope = {
  executionPlanPath: string;
  parentIssueNumbers: number[];
};

export const INVALID_WORKTREE_GROUP = "4.main-invalid";
export const TERMINAL_STATUSES = new Set(["done", "failed", "blocked", "merged"]);
export const MANAGED_WORKTREE_ROOT_ENV = "ORCHESTRATE_MANAGED_WORKTREE_ROOT";
export const BROKEN_WORKTREE_DIR_MARKER = ".broken-";
export const UNREGISTERED_DIR_PREVIEW_LIMIT = 6;
export const EPHEMERAL_UNREGISTERED_TOP_LEVEL_NAMES = new Set([
  ".DS_Store",
  ".env",
  ".env.local",
  ".env.tools",
  ".tmp",
]);
export const MANAGED_WORKTREE_DIR_PATTERN =
  /^(MAIN-[A-Z0-9._-]+|[A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*-\d{3,}[A-Za-z0-9._-]*)$/;

export type StatePayload = SessionStatePayload;
export type GateResultsPayload = SessionGateResultsPayload;
