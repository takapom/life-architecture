import { extractTaskIdFromBranch, normalizeTaskId } from "../../../core/task-governance";
import { resolveGitRemoteAuthContext } from "../git-remote-auth";
import { printDryRun, runGit } from "./common";
import type { Cli, PushLeaseResolution } from "./contracts";
import { PUBLISH_BRANCH_ENV, PUBLISH_BYPASS_ENV } from "./contracts";

export function buildPublishAuthEnv(repoRoot: string, branch: string): NodeJS.ProcessEnv {
  return {
    ...resolveGitRemoteAuthContext({
      repoRoot,
      remote: "origin",
      env: {
        ...Bun.env,
        [PUBLISH_BYPASS_ENV]: "1",
        [PUBLISH_BRANCH_ENV]: branch,
      },
    }).env,
    [PUBLISH_BYPASS_ENV]: "1",
    [PUBLISH_BRANCH_ENV]: branch,
  };
}

function resolveExplicitPushLease(
  repoRoot: string,
  branch: string,
  authEnv: NodeJS.ProcessEnv
): PushLeaseResolution {
  const remoteRef = `refs/heads/${branch}`;
  const output = runGit(repoRoot, ["ls-remote", "--heads", "origin", branch], {
    allowFailure: true,
    extraEnv: authEnv,
  });

  const matches = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/))
    .filter((parts) => parts.length >= 2 && parts[1] === remoteRef);

  if (matches.length > 1) {
    throw new Error(
      `multiple remote heads matched ${remoteRef}; refusing to guess the publish lease`
    );
  }

  if (matches.length === 0) {
    return {
      leaseArg: `--force-with-lease=${remoteRef}:`,
      remoteRef,
    };
  }

  const remoteOid = String(matches[0]?.[0] || "").trim();
  if (!/^[0-9a-f]{40}$/i.test(remoteOid)) {
    throw new Error(
      `remote head for ${remoteRef} did not resolve to a commit OID: ${remoteOid || "(empty)"}`
    );
  }

  return {
    leaseArg: `--force-with-lease=${remoteRef}:${remoteOid}`,
    remoteRef,
  };
}

function collectDuplicateTaskSurfaceBranches(
  repoRoot: string,
  taskId: string,
  branch: string,
  authEnv: NodeJS.ProcessEnv
): { local: string[]; remote: string[] } {
  const normalizedTaskId = normalizeTaskId(taskId);
  const local = runGit(
    repoRoot,
    ["for-each-ref", "--format=%(refname:short)", "refs/heads/task/*"],
    {
      allowFailure: true,
    }
  )
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((candidate) => candidate !== branch)
    .filter((candidate) => normalizeTaskId(extractTaskIdFromBranch(candidate)) === normalizedTaskId)
    .sort();

  const remote = runGit(repoRoot, ["ls-remote", "--heads", "origin", "refs/heads/task/*"], {
    allowFailure: true,
    extraEnv: authEnv,
  })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/)[1] || "")
    .filter((ref) => ref.startsWith("refs/heads/task/"))
    .map((ref) => ref.slice("refs/heads/".length))
    .filter((candidate) => candidate !== branch)
    .filter((candidate) => normalizeTaskId(extractTaskIdFromBranch(candidate)) === normalizedTaskId)
    .sort();

  return { local, remote };
}

export function assertNoDuplicateTaskSurface(
  repoRoot: string,
  taskId: string,
  branch: string,
  authEnv: NodeJS.ProcessEnv
): void {
  const duplicates = collectDuplicateTaskSurfaceBranches(repoRoot, taskId, branch, authEnv);
  if (duplicates.local.length === 0 && duplicates.remote.length === 0) {
    return;
  }

  throw new Error(
    [
      `task ${taskId} already has another canonical branch/worktree publish surface.`,
      ...duplicates.local.map((candidate) => `- local duplicate branch: ${candidate}`),
      ...duplicates.remote.map((candidate) => `- remote duplicate branch: ${candidate}`),
      "- collapse duplicate task surfaces before publish",
    ].join("\n")
  );
}

export function pushBranch(repoRoot: string, cli: Cli, branch: string): void {
  const args = ["push", "origin"];
  const authEnv = buildPublishAuthEnv(repoRoot, branch);
  if (cli.forceWithLease) {
    args.push(resolveExplicitPushLease(repoRoot, branch, authEnv).leaseArg);
  }
  args.push(`${cli.headRef}:refs/heads/${branch}`);

  if (cli.dryRun) {
    printDryRun("git", ["-C", repoRoot, ...args]);
    return;
  }

  runGit(repoRoot, args, {
    extraEnv: authEnv,
  });
}
