import { rmSync } from "node:fs";
import path from "node:path";

import { requireCurrentPublishAdmissionSnapshot } from "../../../../platform/delivery/ci/local-pre-push";
import { fail, resolveRepoRoot } from "../../../adapters/cli";
import {
  detectRepositoryFromOrigin,
  extractTaskIdFromBranch,
  writeVerifiedTaskIssueMarker,
} from "../../../core/task-governance";
import { resolveRepoTaskIssueCatalogSummariesWithRepair } from "../../../core/task-issue-catalog";
import { validatePrBodyTraceability } from "../check-pr-body-traceability";
import {
  collectLandingExclusiveConflicts,
  isLandingExclusiveAdmissionMode,
  listOpenPullRequests,
  renderLandingExclusiveConflictMessage,
} from "../landing-exclusive";
import { resolveBranch } from "./cli";
import { runGh } from "./common";
import { buildCanonicalPrContent } from "./content";
import type { Cli } from "./contracts";
import { collectPullRequestCommits } from "./git";
import { createPullRequest, resolveBranchPullRequestLifecycle, updatePullRequest } from "./github";
import { assertNoDuplicateTaskSurface, buildPublishAuthEnv, pushBranch } from "./push";
import {
  buildCanonicalTaskSpec,
  buildExpectedTaskIssue,
  loadTaskIssueSnapshotFromSource,
} from "./task-issue";
import { resolvePublishLocalValidation } from "./validation";
import {
  classifyIntroducedWorkspaceResidue,
  cleanupIntroducedWorkspaceResidue,
  formatWorkspaceResidue,
  protectActivePublishWorktree,
  readWorkspaceMutationState,
} from "./workspace";

export async function runPublishFlow(cli: Cli): Promise<void> {
  const repoRoot = resolveRepoRoot();
  const branch = resolveBranch(cli, repoRoot);
  const taskId = extractTaskIdFromBranch(branch);
  if (!taskId) {
    fail(`--branch must resolve to task/<TASK_ID>-<slug>: ${branch}`);
  }
  protectActivePublishWorktree({
    branch,
    repoRoot,
    taskId,
  });
  const repository = cli.repository || detectRepositoryFromOrigin(repoRoot);
  const publishAdmissionSnapshot = requireCurrentPublishAdmissionSnapshot({
    branch,
    cwd: repoRoot,
    repository,
    sourcePath: cli.sourcePath || undefined,
  });
  if (!publishAdmissionSnapshot) {
    fail(`publish admission snapshot resolution failed for ${taskId}`);
  }
  const publishAuthEnv = buildPublishAuthEnv(repoRoot, branch);
  assertNoDuplicateTaskSurface(repoRoot, taskId, branch, publishAuthEnv);

  const issueSnapshot = loadTaskIssueSnapshotFromSource(
    publishAdmissionSnapshot.sourcePath,
    taskId
  );
  const canonicalTaskSpec = buildCanonicalTaskSpec(issueSnapshot);
  const expectedTaskIssue = buildExpectedTaskIssue(
    repository,
    issueSnapshot,
    canonicalTaskSpec,
    taskId
  );

  const branchLifecycle = resolveBranchPullRequestLifecycle(repository, branch);
  if (isLandingExclusiveAdmissionMode(canonicalTaskSpec.admission_mode)) {
    const openPullRequests = listOpenPullRequests(repository, (args) => runGh(args));
    const siblingTaskIds = [
      ...new Set(
        openPullRequests
          .filter((pr) => pr.baseBranch === cli.baseBranch)
          .filter(
            (pr) => pr.number !== (branchLifecycle.kind === "open" ? branchLifecycle.pr.number : 0)
          )
          .map((pr) => extractTaskIdFromBranch(pr.headBranch) || "")
          .filter(Boolean)
      ),
    ];
    const taskIssues = await resolveRepoTaskIssueCatalogSummariesWithRepair({
      repoRoot,
      repository,
      sourcePath: publishAdmissionSnapshot.sourcePath,
      taskIds: siblingTaskIds,
    });
    const conflicts = collectLandingExclusiveConflicts({
      baseBranch: cli.baseBranch,
      taskIssues,
      currentPrNumber: branchLifecycle.kind === "open" ? branchLifecycle.pr.number : undefined,
      currentTaskId: taskId,
      openPullRequests,
    });
    if (conflicts.length > 0) {
      fail(
        renderLandingExclusiveConflictMessage({
          conflicts,
          surface: "pr:publish",
          taskId,
        })
      );
    }
  }
  const workspaceStateBeforeValidation = cli.dryRun ? null : readWorkspaceMutationState(repoRoot);
  const validation = resolvePublishLocalValidation({
    repoRoot,
    cli: {
      baseBranch: cli.baseBranch,
      branch,
      dryRun: cli.dryRun,
      headRef: cli.headRef,
      sourcePath: publishAdmissionSnapshot.sourcePath,
    },
    fallbackValidationCommands: [
      ...canonicalTaskSpec.acceptance_checks,
      ...canonicalTaskSpec.tests,
    ],
  });
  if (workspaceStateBeforeValidation) {
    const introducedResidue = classifyIntroducedWorkspaceResidue(
      workspaceStateBeforeValidation,
      readWorkspaceMutationState(repoRoot)
    );
    if (introducedResidue.tracked.length > 0 || introducedResidue.untracked.length > 0) {
      const remainingResidue = cleanupIntroducedWorkspaceResidue(
        repoRoot,
        workspaceStateBeforeValidation,
        introducedResidue
      );
      if (remainingResidue.tracked.length > 0 || remainingResidue.untracked.length > 0) {
        fail(
          [
            "local validation introduced workspace residue that could not be cleaned deterministically:",
            ...formatWorkspaceResidue(remainingResidue),
          ].join("\n")
        );
      }
      process.stdout.write(
        `[pr-publish] local validation cleaned introduced workspace residue (${introducedResidue.tracked.length} tracked, ${introducedResidue.untracked.length} untracked)\n`
      );
    }
  }
  const changedFiles = validation.changedFiles;
  if (changedFiles.length === 0) {
    fail(`no changed files detected for ${cli.headRef} against ${cli.baseBranch}`);
  }

  const commits = collectPullRequestCommits(repoRoot, cli.baseBranch, cli.headRef);
  if (commits.length === 0) {
    fail(`no commits detected for ${cli.headRef} against ${cli.baseBranch}`);
  }

  const content = buildCanonicalPrContent(
    repoRoot,
    cli,
    canonicalTaskSpec,
    expectedTaskIssue,
    changedFiles,
    validation.validationCommands
  );

  try {
    if (!content.body.trim()) {
      fail("generated canonical PR body must not be empty");
    }

    const validationErrors = validatePrBodyTraceability(content.body, {
      changedFiles,
      commits,
      expectedTaskIssue,
    });
    if (validationErrors.length > 0) {
      fail(
        `generated PR traceability contract is invalid:\n${validationErrors
          .map((error) => `- ${error}`)
          .join("\n")}`
      );
    }

    pushBranch(repoRoot, cli, branch);

    if (branchLifecycle.kind === "none") {
      const prUrl = createPullRequest(repository, cli, branch, content);
      if (!cli.dryRun) {
        writeVerifiedTaskIssueMarker(repoRoot, {
          version: 1,
          repository,
          branch,
          task_id: taskId,
          issue_number: issueSnapshot.number,
          issue_url: expectedTaskIssue.issueUrl,
          verified_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        });
      }
      process.stdout.write(
        `[pr-publish] created canonical PR for ${branch}${prUrl ? `: ${prUrl}` : ""}\n`
      );
      return;
    }

    updatePullRequest(repository, cli, branchLifecycle.pr, content);
    if (!cli.dryRun) {
      writeVerifiedTaskIssueMarker(repoRoot, {
        version: 1,
        repository,
        branch,
        task_id: taskId,
        issue_number: issueSnapshot.number,
        issue_url: expectedTaskIssue.issueUrl,
        verified_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      });
    }
    process.stdout.write(`[pr-publish] canonical PR for ${branch}: ${branchLifecycle.pr.url}\n`);
  } finally {
    if (content.cleanupBodyFile) {
      rmSync(path.dirname(content.bodyFile), { recursive: true, force: true });
    }
  }
}
