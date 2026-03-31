import { fail, runGh, runGit } from "./common";
import type { CanonicalPrLifecycleState, PrInfo } from "./contracts";

export function parseGithubRepo(originUrl: string): string {
  const sshMatch = originUrl.match(/^git@github\.com:([^/\s]+\/[^/\s]+?)(?:\.git)?$/);
  if (sshMatch?.[1]) {
    return sshMatch[1];
  }
  const sshUrlMatch = originUrl.match(/^ssh:\/\/git@github\.com\/([^/\s]+\/[^/\s]+?)(?:\.git)?$/);
  if (sshUrlMatch?.[1]) {
    return sshUrlMatch[1];
  }
  const httpsMatch = originUrl.match(/^https:\/\/github\.com\/([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/);
  return httpsMatch?.[1] ?? "";
}

export function resolvePrRepository(
  prRef: string,
  explicitRepository: string,
  repoRoot: string
): string {
  if (explicitRepository) {
    return explicitRepository;
  }
  const urlMatch = prRef.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+\/?$/);
  if (urlMatch?.[1]) {
    return urlMatch[1];
  }
  const originUrl = runGit(repoRoot, ["config", "--get", "remote.origin.url"], {
    allowFailure: true,
  });
  const repository = parseGithubRepo(originUrl);
  if (!repository) {
    fail("failed to resolve GitHub repository slug; pass --repository owner/repo");
  }
  return repository;
}

export function resolvePrNumber(prRef: string): string {
  const urlMatch = prRef.match(/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)\/?$/);
  if (urlMatch?.[1]) {
    return urlMatch[1];
  }
  if (/^\d+$/.test(prRef)) {
    return prRef;
  }
  fail("unsupported --pr value: use a PR number or URL");
}

type PullRequestApiPayload = {
  base?: { ref?: string | null } | null;
  head?: { ref?: string | null; sha?: string | null } | null;
  html_url?: string | null;
  mergeable?: boolean | null;
  mergeable_state?: string | null;
  merged?: boolean | null;
  merged_at?: string | null;
  number?: number | string | null;
  state?: string | null;
};

function normalizePrState(payload: PullRequestApiPayload): string {
  const state = String(payload.state || "")
    .trim()
    .toUpperCase();
  if (state === "OPEN") {
    return "OPEN";
  }
  if (payload.merged === true || String(payload.merged_at || "").trim()) {
    return "MERGED";
  }
  if (state === "CLOSED") {
    return "CLOSED";
  }
  return "";
}

function normalizeMergeable(payload: PullRequestApiPayload): string {
  if (payload.mergeable === true) {
    return "MERGEABLE";
  }
  if (payload.mergeable === false) {
    return "CONFLICTING";
  }
  return "UNKNOWN";
}

function normalizeMergeStateStatus(payload: PullRequestApiPayload): string {
  const normalized = String(payload.mergeable_state || "")
    .trim()
    .replaceAll("-", "_")
    .toUpperCase();
  return normalized || "UNKNOWN";
}

export function fetchPrInfo(repository: string, prNumber: string): PrInfo {
  const { stdout: output } = runGh(["api", `repos/${repository}/pulls/${prNumber}`]);
  let parsed: PullRequestApiPayload;
  try {
    parsed = JSON.parse(output || "{}") as PullRequestApiPayload;
  } catch (error) {
    fail(`unexpected gh api output for PR ${prNumber}: ${(error as Error).message}`);
  }
  const number = String(parsed.number || "").trim();
  const state = normalizePrState(parsed);
  const url = String(parsed.html_url || "").trim();
  const headBranch = String(parsed.head?.ref || "").trim();
  const headSha = String(parsed.head?.sha || "").trim();
  const baseBranch = String(parsed.base?.ref || "").trim();
  const mergeable = normalizeMergeable(parsed);
  const mergeStateStatus = normalizeMergeStateStatus(parsed);
  if (
    !number ||
    !state ||
    !url ||
    !headBranch ||
    !headSha ||
    !baseBranch ||
    !mergeable ||
    !mergeStateStatus
  ) {
    fail(`unexpected gh api output for PR ${prNumber}: ${output}`);
  }
  return {
    baseBranch,
    headBranch,
    headSha,
    mergeStateStatus,
    mergeable,
    number,
    state,
    url,
  };
}

export function classifyCanonicalPrLifecycleState(
  prInfo: Pick<PrInfo, "state">
): CanonicalPrLifecycleState {
  if (prInfo.state === "MERGED") {
    return "merged";
  }
  if (prInfo.state === "OPEN") {
    return "open";
  }
  return "closed-unmerged";
}
