export type MergeMethod = "merge" | "rebase" | "squash";
export type MergeMode = "auto" | "direct" | "require-queue";

export type CliOptions = {
  cleanup: boolean;
  cleanupOnly: boolean;
  dryRun: boolean;
  method: MergeMethod;
  mergeMode: MergeMode;
  prValue: string;
  repository: string;
  repoRoot: string;
};

export type PrInfo = {
  baseBranch: string;
  headBranch: string;
  headSha: string;
  mergeStateStatus: string;
  mergeable: string;
  number: string;
  state: string;
  url: string;
};

export type CanonicalPrLifecycleState = "open" | "merged" | "closed-unmerged";
export type RemoteBranchDeleteResult = "deleted" | "already-gone";
export type MergedTaskWorktreeDisposition = {
  reasons: string[];
  requiresArchive: boolean;
};
export type BranchRefDeletionDisposition = {
  mayDelete: boolean;
  reasons: string[];
};

export const CLEANUP_REANCHORED_ENV = "OMTA_PR_MERGE_SAFE_CLEANUP_REANCHORED";
