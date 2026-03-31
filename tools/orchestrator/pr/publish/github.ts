import { fail } from "../../../adapters/cli";
import { printDryRun, runGh } from "./common";
import type {
  BranchPullRequestLifecycle,
  CanonicalPrContent,
  Cli,
  PullRequestSummary,
} from "./contracts";

function lookupBranchPullRequests(repository: string, branch: string): PullRequestSummary[] {
  const [owner] = repository.split("/");
  const query = new URLSearchParams({
    state: "all",
    head: `${owner}:${branch}`,
  });
  const { stdout } = runGh(["api", `repos/${repository}/pulls?${query.toString()}`]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout || "[]") as unknown;
  } catch (error) {
    fail(`failed to parse pull request lookup response: ${(error as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    fail("pull request lookup response must be an array");
  }
  const resolvePullRequestState = (entry: Record<string, unknown>): PullRequestSummary["state"] => {
    if (entry.merged_at != null) {
      return "MERGED";
    }
    const rawState = String(entry.state || "")
      .trim()
      .toUpperCase();
    return rawState === "OPEN" ? "OPEN" : "CLOSED";
  };
  return parsed
    .filter(
      (entry): entry is Record<string, unknown> =>
        Boolean(entry) && typeof entry === "object" && !Array.isArray(entry)
    )
    .map((entry) => ({
      number: Number(entry.number || 0),
      url: String(entry.html_url || ""),
      body: String(entry.body || ""),
      title: String(entry.title || ""),
      baseRefName: String((entry.base as { ref?: string } | undefined)?.ref || ""),
      headRefName: String((entry.head as { ref?: string } | undefined)?.ref || ""),
      state: resolvePullRequestState(entry),
    }))
    .filter((entry) => Number.isInteger(entry.number) && entry.number > 0);
}

export function classifyBranchPullRequestLifecycle(
  pulls: PullRequestSummary[]
): BranchPullRequestLifecycle {
  if (pulls.length === 0) {
    return { kind: "none" };
  }
  if (pulls.length > 1) {
    return { kind: "ambiguous", pulls: [...pulls] };
  }

  const [pr] = pulls;
  if (!pr) {
    return { kind: "none" };
  }
  if (pr.state === "OPEN") {
    return { kind: "open", pr };
  }
  if (pr.state === "MERGED") {
    return { kind: "merged", pr };
  }
  return { kind: "closed-unmerged", pr };
}

export function describeBranchPullRequestLifecycleConflict(
  branch: string,
  lifecycle: Extract<
    BranchPullRequestLifecycle,
    { kind: "merged" | "closed-unmerged" | "ambiguous" }
  >
): string {
  if (lifecycle.kind === "ambiguous") {
    return [
      `branch ${branch} already has multiple PR records; refusing to guess the canonical publish target.`,
      ...lifecycle.pulls.map((pr) => `- #${pr.number} ${pr.state}: ${pr.url}`),
      "- collapse branch PR history before re-running pr:publish",
    ].join("\n");
  }

  const actionHint =
    lifecycle.kind === "merged"
      ? "run pr:merge:safe --cleanup for the merged PR or start a fresh canonical task branch"
      : "re-open or replace the closed PR history before re-running pr:publish";
  return [
    `branch ${branch} already has ${lifecycle.kind === "merged" ? "a merged" : "a closed"} PR and cannot be republished implicitly.`,
    `- #${lifecycle.pr.number} ${lifecycle.pr.state}: ${lifecycle.pr.url}`,
    `- ${actionHint}`,
  ].join("\n");
}

export function resolveBranchPullRequestLifecycle(
  repository: string,
  branch: string
): Extract<BranchPullRequestLifecycle, { kind: "none" | "open" }> {
  const lifecycle = classifyBranchPullRequestLifecycle(
    lookupBranchPullRequests(repository, branch)
  );
  if (
    lifecycle.kind === "merged" ||
    lifecycle.kind === "closed-unmerged" ||
    lifecycle.kind === "ambiguous"
  ) {
    fail(describeBranchPullRequestLifecycleConflict(branch, lifecycle));
  }
  return lifecycle;
}

export function createPullRequest(
  repository: string,
  cli: Cli,
  branch: string,
  content: CanonicalPrContent
): string {
  const args = [
    "pr",
    "create",
    "--repo",
    repository,
    "--base",
    cli.baseBranch,
    "--head",
    branch,
    "--title",
    content.title,
    "--body-file",
    content.bodyFile,
  ];
  if (cli.draft) {
    args.push("--draft");
  }
  if (cli.dryRun) {
    printDryRun("gh", args);
    return "";
  }
  return runGh(args).stdout;
}

export function updatePullRequest(
  repository: string,
  cli: Cli,
  pr: PullRequestSummary,
  content: CanonicalPrContent
): void {
  const args = ["pr", "edit", String(pr.number), "--repo", repository, "--title", content.title];
  args.push("--body-file", content.bodyFile);
  if (cli.baseBranch && cli.baseBranch !== pr.baseRefName) {
    args.push("--base", cli.baseBranch);
  }
  if (cli.dryRun) {
    printDryRun("gh", args);
    return;
  }
  runGh(args);
}
