import type { PullRequestCommit } from "../check-pr-body-traceability";
import { runGit } from "./common";

export function resolveDiffBase(repoRoot: string, baseBranch: string): string {
  const remoteRef = `refs/remotes/origin/${baseBranch}`;
  const remoteExists = runGit(repoRoot, ["show-ref", "--verify", "--hash", remoteRef], {
    allowFailure: true,
  });
  return remoteExists ? remoteRef : baseBranch;
}

export function collectChangedFiles(
  repoRoot: string,
  baseBranch: string,
  headRef: string
): string[] {
  const diffBase = resolveDiffBase(repoRoot, baseBranch);
  const output = runGit(repoRoot, ["diff", "--name-only", `${diffBase}...${headRef}`], {
    allowFailure: true,
  });
  return [
    ...new Set(
      output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    ),
  ].sort();
}

export function collectPullRequestCommits(
  repoRoot: string,
  baseBranch: string,
  headRef: string
): PullRequestCommit[] {
  const diffBase = resolveDiffBase(repoRoot, baseBranch);
  const output = runGit(
    repoRoot,
    ["log", "--format=%H%x1f%P%x1f%B%x1e", `${diffBase}..${headRef}`],
    {
      allowFailure: true,
    }
  );
  if (!output) {
    return [];
  }

  return output
    .split("\x1e")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [sha = "", parentLine = "", message = ""] = entry.split("\x1f");
      const parentCount = parentLine.trim() ? parentLine.trim().split(/\s+/).length : 0;
      return {
        sha: sha.trim(),
        message,
        parentCount,
      } satisfies PullRequestCommit;
    })
    .filter((entry) => entry.sha);
}
