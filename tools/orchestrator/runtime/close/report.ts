import { summarizeManagedWorktreeArchiveDispositionCounts } from "./cleanup";
import { nowIsoUtc } from "./common";
import type {
  CleanupPlan,
  CleanupResult,
  JsonObject,
  ManagedWorktreeArchiveTarget,
  ManagedWorktreeResidueSummary,
  RepoSafetySummary,
  ResidueItem,
  WorktreeClassification,
  WorktreeClassificationSummary,
} from "./contracts";

export function buildCleanupApplySummary(options: {
  cleanupPlan: CleanupPlan;
  cleanupPlanPath: string;
  repository: string;
  cleanup: CleanupResult[];
  dryRun: boolean;
}): JsonObject {
  return {
    generated_at: nowIsoUtc(),
    state_backend: options.cleanupPlan.state_backend,
    repository: options.repository,
    base_branch: options.cleanupPlan.base_branch,
    run_issue_number: options.cleanupPlan.run_issue_number,
    run_id: options.cleanupPlan.run_id,
    cleanup_plan_id: options.cleanupPlan.plan_id,
    cleanup_plan_input: options.cleanupPlanPath,
    cleanup_count: options.cleanup.length,
    pr_cleanup_count: options.cleanup.filter((entry) => entry.kind === "pr_cleanup").length,
    managed_worktree_delete_count: options.cleanup.filter(
      (entry) => entry.kind === "managed_worktree_delete"
    ).length,
    managed_worktree_archive_count: options.cleanup.filter(
      (entry) => entry.kind === "managed_worktree_archive"
    ).length,
    managed_worktree_archive_disposition_counts: summarizeManagedWorktreeArchiveDispositionCounts(
      options.cleanupPlan.targets.filter(
        (target): target is ManagedWorktreeArchiveTarget =>
          target.kind === "managed_worktree_archive"
      )
    ),
    cleanup: options.cleanup,
    dry_run: options.dryRun,
  };
}

export function buildVerifyCloseoutSummary(options: {
  stateDir: string;
  stateBackend: "github" | "local";
  nodeCount: number;
  residues: ResidueItem[];
}): JsonObject {
  return {
    generated_at: nowIsoUtc(),
    state_dir: options.stateDir,
    state_backend: options.stateBackend,
    node_count: options.nodeCount,
    residue_count: options.residues.length,
    residue_nodes: options.residues.map((item) => item.node_id),
  };
}

export function buildCleanupPlanSummary(options: {
  stateDir: string;
  stateBackend: "github" | "local";
  repository: string;
  runIssueNumber: number;
  runId: string;
  cleanupPlan: CleanupPlan;
  cleanupPlanPath: string;
  repoSafetyPath: string;
  managedWorktreeResiduePath: string;
}): JsonObject {
  return {
    generated_at: nowIsoUtc(),
    state_dir: options.stateDir,
    state_backend: options.stateBackend,
    repository: options.repository,
    base_branch: options.cleanupPlan.base_branch,
    run_issue_number: options.runIssueNumber,
    run_id: options.runId,
    cleanup_plan_output: options.cleanupPlanPath,
    cleanup_plan_id: options.cleanupPlan.plan_id,
    cleanup_target_count: options.cleanupPlan.target_count,
    pr_cleanup_target_count: options.cleanupPlan.pr_target_count,
    managed_worktree_delete_target_count: options.cleanupPlan.managed_worktree_delete_target_count,
    managed_worktree_archive_target_count:
      options.cleanupPlan.managed_worktree_archive_target_count,
    managed_worktree_archive_disposition_counts:
      options.cleanupPlan.managed_worktree_archive_disposition_counts,
    cleanup_targets: options.cleanupPlan.targets,
    repo_safety_output: options.repoSafetyPath,
    managed_worktree_residue_output: options.managedWorktreeResiduePath,
  };
}

export function buildCloseRunNextActions(options: {
  followupPath: string;
  followupResidues: ResidueItem[];
  worktreeSummary: WorktreeClassificationSummary;
  repoSafety: RepoSafetySummary;
  managedWorktreeResiduePath: string;
  cleanup: CleanupResult[];
  cleanupPlanPath: string;
}): string[] {
  const nextActions: string[] = [];
  if (options.followupResidues.length > 0) {
    nextActions.push(`Create follow-up task issues from ${options.followupPath}`);
  }
  const escalatedResidues = options.followupResidues.filter(
    (item) => item.review_escalation.level && item.review_escalation.level !== "none"
  );
  if (escalatedResidues.length > 0) {
    nextActions.push(
      `Resolve reviewer escalations for ${escalatedResidues.map((item) => item.node_id).join(", ")}`
    );
  }
  if (options.worktreeSummary.next_action) {
    nextActions.push(options.worktreeSummary.next_action);
  }
  if (options.repoSafety.unregistered_managed_dir_count > 0) {
    nextActions.push(
      `Review managed worktree residue artifact ${options.managedWorktreeResiduePath}`
    );
  }
  if (options.repoSafety.next_action) {
    nextActions.push(options.repoSafety.next_action);
  }
  if (options.cleanup.length === 0) {
    nextActions.push("No merged task PRs required cleanup plan");
  } else {
    nextActions.push(`Apply cleanup via cleanup-apply using plan ${options.cleanupPlanPath}`);
  }
  return nextActions;
}

export function buildCloseRunSummary(options: {
  stateDir: string;
  stateBackend: "github" | "local";
  repository: string;
  nodeCount: number;
  residues: ResidueItem[];
  followupResidues: ResidueItem[];
  skippedFollowupResidues: ResidueItem[];
  cleanupPlanPath: string;
  cleanupPlan: CleanupPlan;
  cleanup: CleanupResult[];
  parentIssueSync: JsonObject;
  repoSafety: RepoSafetySummary;
  managedWorktreeResiduePath: string;
  managedWorktreeResidue: ManagedWorktreeResidueSummary;
  classifications: WorktreeClassification[];
  worktreeSummary: WorktreeClassificationSummary;
  followupOutput: string;
  nextActions: string[];
}): JsonObject {
  return {
    generated_at: nowIsoUtc(),
    state_dir: options.stateDir,
    state_backend: options.stateBackend,
    repository: options.repository,
    node_count: options.nodeCount,
    residue_count: options.residues.length,
    residue: options.residues,
    followup_residue_count: options.followupResidues.length,
    followup_residue: options.followupResidues,
    skipped_followup_residue_count: options.skippedFollowupResidues.length,
    skipped_followup_residue: options.skippedFollowupResidues,
    cleanup_plan_output: options.cleanupPlanPath,
    cleanup_plan_id: options.cleanupPlan.plan_id,
    cleanup_target_count: options.cleanupPlan.target_count,
    pr_cleanup_target_count: options.cleanupPlan.pr_target_count,
    managed_worktree_delete_target_count: options.cleanupPlan.managed_worktree_delete_target_count,
    managed_worktree_archive_target_count:
      options.cleanupPlan.managed_worktree_archive_target_count,
    managed_worktree_archive_disposition_counts:
      options.cleanupPlan.managed_worktree_archive_disposition_counts,
    cleanup: options.cleanup,
    parent_issue_sync: options.parentIssueSync,
    repo_safety: options.repoSafety,
    managed_worktree_residue_output: options.managedWorktreeResiduePath,
    managed_worktree_residue: options.managedWorktreeResidue,
    worktree_classification: options.classifications,
    invalid_worktree_count: options.worktreeSummary.invalid_worktree_count,
    invalid_worktrees: options.worktreeSummary.invalid_worktrees,
    followup_output: options.followupOutput,
    cleanup_apply_requested: false,
    next_actions: options.nextActions,
  };
}
