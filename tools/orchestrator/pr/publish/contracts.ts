import type { TaskMetadata } from "../../../core/task-governance-types";

export type Cli = {
  repository: string;
  sourcePath: string;
  branch: string;
  headRef: string;
  baseBranch: string;
  title: string;
  bodyFile: string;
  draft: boolean;
  dryRun: boolean;
  forceWithLease: boolean;
};

export type PullRequestSummary = {
  number: number;
  url: string;
  body: string;
  title: string;
  baseRefName: string;
  headRefName: string;
  state: "OPEN" | "MERGED" | "CLOSED";
};

export type BranchPullRequestLifecycle =
  | { kind: "none" }
  | { kind: "open"; pr: PullRequestSummary }
  | { kind: "merged"; pr: PullRequestSummary }
  | { kind: "closed-unmerged"; pr: PullRequestSummary }
  | { kind: "ambiguous"; pulls: PullRequestSummary[] };

export type CanonicalPrContent = {
  body: string;
  bodyFile: string;
  cleanupBodyFile: boolean;
  title: string;
};

export type PublishLocalValidationResult = {
  changedFiles: string[];
  validationCommands: string[];
};

export type PushLeaseResolution = {
  leaseArg: string;
  remoteRef: string;
};

export type WorkspaceMutationState = {
  tracked: string[];
  untracked: string[];
};

export type WorkspaceResidue = WorkspaceMutationState;

export type TaskIssueSnapshot = {
  body: string;
  issueUrl: string;
  metadata: TaskMetadata;
  number: number;
  title: string;
};

export const PUBLISH_BYPASS_ENV = "OMTA_TASK_PR_PUBLISH_BYPASS";
export const PUBLISH_BRANCH_ENV = "OMTA_TASK_PR_PUBLISH_BRANCH";
