import { fail } from "../../adapters/cli";
import type { RepoTaskIssueCatalogSummary } from "../../core/task-issue-catalog";
import { extractTaskIdFromBranch, normalizeTaskId } from "../../core/task-issue-guard";

export type OpenPullRequestSummary = {
  baseBranch: string;
  headBranch: string;
  number: number;
  url: string;
};

export type LandingExclusiveConflict = {
  headBranch: string;
  issueUrl: string;
  prNumber: number;
  prUrl: string;
  taskId: string;
};

export function isLandingExclusiveAdmissionMode(value: string | undefined): boolean {
  return (
    String(value || "")
      .trim()
      .toLowerCase() === "landing-exclusive"
  );
}

export function listOpenPullRequests(
  repository: string,
  runGh: (args: string[]) => { stdout: string }
): OpenPullRequestSummary[] {
  const { stdout } = runGh(["api", `repos/${repository}/pulls?state=open&per_page=100`]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout || "[]") as unknown;
  } catch (error) {
    fail(`failed to parse open PR response: ${(error as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    fail("open PR response must be an array");
  }
  return parsed
    .filter(
      (entry): entry is Record<string, unknown> =>
        Boolean(entry) && typeof entry === "object" && !Array.isArray(entry)
    )
    .map((entry) => ({
      baseBranch: String((entry.base as { ref?: string } | undefined)?.ref || "").trim(),
      headBranch: String((entry.head as { ref?: string } | undefined)?.ref || "").trim(),
      number: Number(entry.number || 0),
      url: String(entry.html_url || "").trim(),
    }))
    .filter(
      (entry) =>
        Number.isInteger(entry.number) &&
        entry.number > 0 &&
        entry.baseBranch.length > 0 &&
        entry.headBranch.length > 0 &&
        entry.url.length > 0
    )
    .sort((left, right) => left.number - right.number);
}

export function collectLandingExclusiveConflicts(options: {
  baseBranch: string;
  taskIssues: ReadonlyArray<RepoTaskIssueCatalogSummary>;
  currentPrNumber?: number | string;
  currentTaskId: string;
  openPullRequests: OpenPullRequestSummary[];
}): LandingExclusiveConflict[] {
  const currentTaskId = normalizeTaskId(options.currentTaskId);
  const currentPrNumber = Number(options.currentPrNumber || 0);
  const landingExclusiveIssues = new Map(
    options.taskIssues
      .filter((issue) => issue.state === "OPEN")
      .filter((issue) => isLandingExclusiveAdmissionMode(issue.metadata.admission_mode))
      .map((issue) => [issue.taskId, issue] as const)
  );

  return options.openPullRequests
    .filter((pr) => pr.baseBranch === options.baseBranch)
    .filter((pr) => pr.number !== currentPrNumber)
    .map((pr) => {
      const taskId = normalizeTaskId(extractTaskIdFromBranch(pr.headBranch) || "");
      if (!taskId || taskId === currentTaskId) {
        return null;
      }
      const issue = landingExclusiveIssues.get(taskId);
      if (!issue) {
        return null;
      }
      return {
        headBranch: pr.headBranch,
        issueUrl: issue.htmlUrl,
        prNumber: pr.number,
        prUrl: pr.url,
        taskId,
      };
    })
    .filter((conflict): conflict is LandingExclusiveConflict => conflict !== null);
}

export function renderLandingExclusiveConflictMessage(options: {
  conflicts: LandingExclusiveConflict[];
  surface: "pr:publish" | "pr:merge:safe";
  taskId: string;
}): string {
  return [
    `${options.surface} denied for ${options.taskId}: another landing-exclusive task already owns the landing lane.`,
    ...options.conflicts.map(
      (conflict) =>
        `- ${conflict.taskId}: PR #${conflict.prNumber} ${conflict.prUrl} (${conflict.headBranch})`
    ),
    "- wait for the other landing-exclusive PR to leave the landing lane or retarget the task admission mode",
  ].join("\n");
}
