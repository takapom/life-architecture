#!/usr/bin/env bun

import {
  buildCurrentTaskSnapshotRefreshArgs,
  loadCanonicalTaskIssuesForTaskIdsFromControlPlane,
  loadRepoWideCanonicalTaskIssues,
  renderTaskPrSteadyStateDrift,
  resolveTaskPrSteadyStateContext,
  runTaskPrSteadyStateCli,
  selectRepoWideCanonicalTaskIssues,
  shouldSuppressZeroOpenPrViolationForAdmission,
  stabilizeTaskPrSteadyStateReport,
} from "../../repoctl/task-pr-steady-state";

export {
  buildCurrentTaskSnapshotRefreshArgs,
  loadCanonicalTaskIssuesForTaskIdsFromControlPlane,
  loadRepoWideCanonicalTaskIssues,
  renderTaskPrSteadyStateDrift,
  resolveTaskPrSteadyStateContext,
  selectRepoWideCanonicalTaskIssues,
  shouldSuppressZeroOpenPrViolationForAdmission,
  stabilizeTaskPrSteadyStateReport,
};

if (import.meta.main) {
  runTaskPrSteadyStateCli().catch((error) => {
    process.stderr.write(`[check-task-pr-steady-state] ERROR: ${(error as Error).message}\n`);
    process.exit(1);
  });
}
