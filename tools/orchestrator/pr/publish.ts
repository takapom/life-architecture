#!/usr/bin/env bun

import { parseCli } from "./publish/cli";
import { runPublishFlow } from "./publish/flow";
import {
  classifyBranchPullRequestLifecycle as classifyBranchPullRequestLifecycleCore,
  describeBranchPullRequestLifecycleConflict as describeBranchPullRequestLifecycleConflictCore,
} from "./publish/github";
import {
  buildCanonicalTaskSpec as buildCanonicalTaskSpecCore,
  buildExpectedTaskIssue as buildExpectedTaskIssueCore,
  loadTaskIssueSnapshotFromSource as loadTaskIssueSnapshotFromSourceCore,
  normalizeTitleFromIssueTitle as normalizeTitleFromIssueTitleCore,
} from "./publish/task-issue";
import {
  buildPublishLocalValidationOptions as buildPublishLocalValidationOptionsCore,
  buildPublishLocalValidationResult as buildPublishLocalValidationResultCore,
  withScopedPublishTaskIssueSourceEnv as withScopedPublishTaskIssueSourceEnvCore,
} from "./publish/validation";
import {
  classifyIntroducedWorkspaceResidue as classifyIntroducedWorkspaceResidueCore,
  cleanupIntroducedWorkspaceResidue as cleanupIntroducedWorkspaceResidueCore,
  protectActivePublishWorktree as protectActivePublishWorktreeCore,
  readActivePublishWorktreeProtection as readActivePublishWorktreeProtectionCore,
  readWorkspaceMutationState as readWorkspaceMutationStateCore,
} from "./publish/workspace";

export const buildExpectedTaskIssue = buildExpectedTaskIssueCore;
export const loadTaskIssueSnapshotFromSource = loadTaskIssueSnapshotFromSourceCore;
export const buildCanonicalTaskSpec = buildCanonicalTaskSpecCore;
export const normalizeTitleFromIssueTitle = normalizeTitleFromIssueTitleCore;
export const classifyBranchPullRequestLifecycle = classifyBranchPullRequestLifecycleCore;
export const describeBranchPullRequestLifecycleConflict =
  describeBranchPullRequestLifecycleConflictCore;
export const readWorkspaceMutationState = readWorkspaceMutationStateCore;
export const classifyIntroducedWorkspaceResidue = classifyIntroducedWorkspaceResidueCore;
export const cleanupIntroducedWorkspaceResidue = cleanupIntroducedWorkspaceResidueCore;
export const protectActivePublishWorktree = protectActivePublishWorktreeCore;
export const readActivePublishWorktreeProtection = readActivePublishWorktreeProtectionCore;
export const buildPublishLocalValidationOptions = buildPublishLocalValidationOptionsCore;
export const buildPublishLocalValidationResult = buildPublishLocalValidationResultCore;
export const withScopedPublishTaskIssueSourceEnv = withScopedPublishTaskIssueSourceEnvCore;

if (import.meta.main) {
  try {
    await runPublishFlow(parseCli(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`[pr-publish] ERROR: ${(error as Error).message}\n`);
    process.exit(1);
  }
}
