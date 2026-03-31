import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { fail } from "../../../tools/adapters/cli";

export type GitWorktreeEntry = {
  branch: string;
  path: string;
};

export type WorktreeRootOwnerRecord = {
  version: 2;
  canonicalTaskRoot: string;
  canonicalMainWorktree: string;
  gitCommonDir: string;
  repoInstanceId: string;
  updatedAt: string;
};

type LegacyWorktreeRootOwnerRecord = {
  version: 1;
  canonicalMainWorktree: string;
  gitCommonDir: string;
  repoRoot: string;
  updatedAt: string;
};

type MainWorktreeCandidate = {
  ownerRecord: WorktreeRootOwnerRecord | null;
  path: string;
};

export type WorktreeTopologySnapshot = {
  canonicalMainWorktree: string;
  canonicalTaskRoot: string;
  currentRepoRoot: string;
  mainWorktreeCandidates: MainWorktreeCandidate[];
  repoInstanceId: string;
  reservedBaseWorktree: string;
  worktrees: GitWorktreeEntry[];
};

type ResolveWorktreeTopologyOptions = {
  ownerRecordResolver?: (taskRoot: string) => WorktreeRootOwnerRecord | null;
  repoInstanceId?: string;
  repoRoot: string;
  worktrees?: GitWorktreeEntry[];
};

const WORKTREE_ROOT_OWNER_MARKER = "root-owner.json";

function normalizeBranch(ref: string): string {
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

export function canonicalPath(targetPath: string): string {
  try {
    return realpathSync.native(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

export function resolveCheckoutRoot(startPath: string): string {
  let current = canonicalPath(startPath);
  if (!existsSync(current)) {
    current = path.dirname(current);
  }

  while (true) {
    if (existsSync(path.join(current, ".git"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  const result = spawnSync(
    "git",
    ["-C", canonicalPath(startPath), "rev-parse", "--show-toplevel"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  if (result.status !== 0) {
    const detail = `${result.stderr || ""}\n${result.stdout || ""}`.trim();
    fail(`git rev-parse --show-toplevel failed: ${detail || `exit=${result.status}`}`);
  }
  return canonicalPath(String(result.stdout || "").trim());
}

export function isInsidePath(candidatePath: string, parentPath: string): boolean {
  const canonicalCandidatePath = canonicalPath(candidatePath);
  const canonicalParentPath = canonicalPath(parentPath);
  return (
    canonicalCandidatePath === canonicalParentPath ||
    canonicalCandidatePath.startsWith(`${canonicalParentPath}${path.sep}`)
  );
}

function hasDirectoryGitMetadata(worktreePath: string): boolean {
  try {
    return lstatSync(path.join(worktreePath, ".git")).isDirectory();
  } catch {
    return false;
  }
}

function resolveAbsoluteGitCommonDir(repoRoot: string): string {
  const checkoutRoot = resolveCheckoutRoot(repoRoot);
  const resolved = runGit(checkoutRoot, ["rev-parse", "--git-common-dir"]);
  const absolute = path.isAbsolute(resolved) ? resolved : path.resolve(checkoutRoot, resolved);
  return canonicalPath(absolute);
}

export function runGit(repoRoot: string, args: string[]): string {
  const result = spawnSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const detail = `${result.stderr || ""}\n${result.stdout || ""}`.trim();
    fail(`git ${args.join(" ")} failed: ${detail || `exit=${result.status}`}`);
  }
  return String(result.stdout || "").trim();
}

export function listGitWorktrees(repoRoot: string): GitWorktreeEntry[] {
  const output = runGit(resolveCheckoutRoot(repoRoot), ["worktree", "list", "--porcelain"]);
  const worktrees: GitWorktreeEntry[] = [];
  let currentPath = "";
  let currentBranch = "";

  const flush = () => {
    if (!currentPath) {
      return;
    }
    worktrees.push({
      branch: normalizeBranch(currentBranch),
      path: canonicalPath(currentPath),
    });
    currentPath = "";
    currentBranch = "";
  };

  for (const line of output.split(/\r?\n/u)) {
    if (!line.trim()) {
      flush();
      continue;
    }
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length).trim();
      continue;
    }
    if (line.startsWith("branch ")) {
      currentBranch = line.slice("branch ".length).trim();
    }
  }

  flush();
  return worktrees;
}

function resolveReservedBaseWorktreeFromEntries(
  repoRoot: string,
  worktrees: readonly GitWorktreeEntry[],
  fallbackWorktree: string
): string {
  const reservedBaseWorktrees = worktrees.filter((worktree) =>
    hasDirectoryGitMetadata(worktree.path)
  );
  if (reservedBaseWorktrees.length === 1) {
    return reservedBaseWorktrees[0]?.path || canonicalPath(repoRoot);
  }
  if (reservedBaseWorktrees.length > 1) {
    fail(
      `multiple reserved base worktrees found: ${reservedBaseWorktrees.map((entry) => entry.path).join(", ")}`
    );
  }
  return fallbackWorktree;
}

export function resolveCanonicalTaskRoot(mainWorktree: string): string {
  return canonicalPath(path.join(mainWorktree, "..", "wt"));
}

export function buildRepoInstanceId(gitCommonDir: string): string {
  const digest = createHash("sha256").update(canonicalPath(gitCommonDir)).digest("hex");
  return `repoinst-${digest.slice(0, 16)}`;
}

function resolveRepoInstanceId(repoRoot: string): string {
  return buildRepoInstanceId(resolveAbsoluteGitCommonDir(repoRoot));
}

function resolveWorktreeRootOwnerMarkerPath(taskRoot: string): string {
  return path.join(canonicalPath(taskRoot), ".omta", WORKTREE_ROOT_OWNER_MARKER);
}

function readWorktreeRootOwnerRecordForTaskRoot(taskRoot: string): WorktreeRootOwnerRecord | null {
  const markerPath = resolveWorktreeRootOwnerMarkerPath(taskRoot);
  if (!existsSync(markerPath)) {
    return null;
  }
  const parsed = parseWorktreeRootOwnerRecord(readFileSync(markerPath, "utf8"), markerPath);
  if (parsed && parsed.canonicalTaskRoot !== canonicalPath(taskRoot)) {
    fail(
      `invalid worktree root owner marker: ${markerPath} declares canonicalTaskRoot=${parsed.canonicalTaskRoot} but lives under ${canonicalPath(taskRoot)}`
    );
  }
  return parsed;
}

function describeMainWorktreeCandidates(candidates: readonly MainWorktreeCandidate[]): string {
  return candidates.map((candidate) => candidate.path).join(", ");
}

function candidateMatchesOwnerRecord(
  candidate: MainWorktreeCandidate,
  repoInstanceId: string
): boolean {
  if (!candidate.ownerRecord) {
    return false;
  }
  return (
    candidate.ownerRecord.repoInstanceId === repoInstanceId &&
    candidate.ownerRecord.canonicalMainWorktree === candidate.path &&
    candidate.ownerRecord.canonicalTaskRoot === resolveCanonicalTaskRoot(candidate.path)
  );
}

function resolveCanonicalMainWorktreeFromCandidates(params: {
  currentRepoRoot: string;
  candidates: readonly MainWorktreeCandidate[];
  repoInstanceId: string;
}): string {
  const { candidates, currentRepoRoot, repoInstanceId } = params;
  if (candidates.length === 0) {
    fail("failed to resolve the canonical main worktree from git worktree list");
  }
  if (candidates.length === 1) {
    const onlyCandidate = candidates[0] as MainWorktreeCandidate;
    if (onlyCandidate.ownerRecord && onlyCandidate.ownerRecord.repoInstanceId !== repoInstanceId) {
      fail(
        `sibling ../wt ownership conflict detected for repo instance ${repoInstanceId}; foreign owner marker found under ${resolveCanonicalTaskRoot(
          onlyCandidate.path
        )}`
      );
    }
    if (
      onlyCandidate.ownerRecord &&
      onlyCandidate.ownerRecord.canonicalMainWorktree !== onlyCandidate.path
    ) {
      fail(
        `sibling ../wt owner record points at ${onlyCandidate.ownerRecord.canonicalMainWorktree}, but the only checked-out main worktree is ${onlyCandidate.path}`
      );
    }
    return candidates[0]?.path || canonicalPath(currentRepoRoot);
  }

  const foreignOwnedTaskRoots = candidates.filter(
    (candidate) => candidate.ownerRecord && candidate.ownerRecord.repoInstanceId !== repoInstanceId
  );
  if (foreignOwnedTaskRoots.length > 0) {
    fail(
      `sibling ../wt ownership conflict detected for repo instance ${repoInstanceId}; foreign owner markers found under ${foreignOwnedTaskRoots
        .map((candidate) => resolveCanonicalTaskRoot(candidate.path))
        .join(", ")}`
    );
  }

  const ownedCandidates = candidates.filter((candidate) =>
    candidateMatchesOwnerRecord(candidate, repoInstanceId)
  );
  if (ownedCandidates.length === 1) {
    return ownedCandidates[0]?.path || canonicalPath(currentRepoRoot);
  }
  if (ownedCandidates.length > 1) {
    fail(
      `multiple sibling ../wt roots claim repo instance ${repoInstanceId}: ${ownedCandidates
        .map((candidate) => resolveCanonicalTaskRoot(candidate.path))
        .join(", ")}`
    );
  }

  const reservedBaseWorktrees = candidates.filter((candidate) =>
    hasDirectoryGitMetadata(candidate.path)
  );
  if (reservedBaseWorktrees.length === 1) {
    return reservedBaseWorktrees[0]?.path || canonicalPath(currentRepoRoot);
  }
  if (reservedBaseWorktrees.length > 1) {
    fail(
      `multiple reserved base worktrees found: ${reservedBaseWorktrees
        .map((candidate) => candidate.path)
        .join(", ")}`
    );
  }

  fail(
    `multiple main worktrees found without an owned sibling ../wt root: ${describeMainWorktreeCandidates(candidates)}`
  );
}

export function resolveReservedBaseWorktree(repoRoot: string): string {
  return resolveWorktreeTopology({ repoRoot }).reservedBaseWorktree;
}

export function resolveWorktreeTopology(
  input: ResolveWorktreeTopologyOptions
): WorktreeTopologySnapshot {
  const currentRepoRoot = resolveCheckoutRoot(input.repoRoot);
  const worktrees = (input.worktrees ?? listGitWorktrees(currentRepoRoot)).map((worktree) => ({
    branch: normalizeBranch(worktree.branch),
    path: canonicalPath(worktree.path),
  }));
  const repoInstanceId = input.repoInstanceId ?? resolveRepoInstanceId(currentRepoRoot);
  const ownerRecordResolver = input.ownerRecordResolver ?? readWorktreeRootOwnerRecordForTaskRoot;
  const mainWorktreeCandidates = worktrees
    .filter((worktree) => worktree.branch === "main")
    .map((worktree) => ({
      ownerRecord: ownerRecordResolver(resolveCanonicalTaskRoot(worktree.path)),
      path: worktree.path,
    }));
  const canonicalMainWorktree = resolveCanonicalMainWorktreeFromCandidates({
    candidates: mainWorktreeCandidates,
    currentRepoRoot,
    repoInstanceId,
  });

  return {
    canonicalMainWorktree,
    canonicalTaskRoot: resolveCanonicalTaskRoot(canonicalMainWorktree),
    currentRepoRoot,
    mainWorktreeCandidates,
    repoInstanceId,
    reservedBaseWorktree: resolveReservedBaseWorktreeFromEntries(
      currentRepoRoot,
      worktrees,
      canonicalMainWorktree
    ),
    worktrees,
  };
}

export function resolveCanonicalMainWorktree(repoRoot: string): string {
  return resolveWorktreeTopology({ repoRoot }).canonicalMainWorktree;
}

export function resolveCanonicalTaskRootFromRepoRoot(repoRoot: string): string {
  return resolveCanonicalTaskRoot(resolveCanonicalMainWorktree(repoRoot));
}

export function resolveCanonicalSessionRootFromRepoRoot(repoRoot: string): string {
  return path.join(resolveCanonicalTaskRootFromRepoRoot(repoRoot), "sessions");
}

export const HUMAN_CODEX_SESSION_NODE = "human-codex";

export function resolveHumanCodexSessionScratchRootFromRepoRoot(
  repoRoot: string,
  sessionId: string
): string {
  return path.join(
    resolveCanonicalSessionRootFromRepoRoot(repoRoot),
    sessionId,
    HUMAN_CODEX_SESSION_NODE
  );
}

export function resolveCodexSessionContractPath(sessionScratchRoot: string): string {
  return path.join(sessionScratchRoot, "session-contract.json");
}

export function resolveCodexSessionTmpRoot(sessionScratchRoot: string): string {
  return path.join(sessionScratchRoot, "tmp");
}

export function resolveCanonicalArchiveRootFromRepoRoot(repoRoot: string): string {
  return path.join(resolveCanonicalTaskRootFromRepoRoot(repoRoot), "_dead-wt-archive");
}

export function resolveTaskWorktreeProtectionRootFromRepoRoot(repoRoot: string): string {
  return path.join(
    resolveCanonicalTaskRootFromRepoRoot(repoRoot),
    ".omta",
    "task-worktree-protection"
  );
}

export function resolveTaskScopeRootFromRepoRoot(repoRoot: string): string {
  return path.join(resolveCanonicalTaskRootFromRepoRoot(repoRoot), ".omta", "task-scope");
}

export function resolveTaskScopeLockRootFromRepoRoot(repoRoot: string): string {
  return path.join(resolveTaskScopeRootFromRepoRoot(repoRoot), "locks");
}

export function resolveVerifyCacheRootFromRepoRoot(repoRoot: string): string {
  return path.join(resolveCanonicalTaskRootFromRepoRoot(repoRoot), ".omta", "verify-cache");
}

export function resolveRustRuntimeRootFromRepoRoot(repoRoot: string): string {
  return path.join(resolveCanonicalTaskRootFromRepoRoot(repoRoot), ".omta", "rust-runtime");
}

export function resolveWorktreeRootOwnerMarkerPathFromRepoRoot(repoRoot: string): string {
  return path.join(
    resolveCanonicalTaskRootFromRepoRoot(repoRoot),
    ".omta",
    WORKTREE_ROOT_OWNER_MARKER
  );
}

function buildExpectedWorktreeRootOwnerRecord(
  repoRoot: string,
  nowMs = Date.now()
): WorktreeRootOwnerRecord {
  const canonicalRepoRoot = resolveCheckoutRoot(repoRoot);
  const canonicalMainWorktree = resolveCanonicalMainWorktree(canonicalRepoRoot);
  const gitCommonDir = resolveAbsoluteGitCommonDir(canonicalRepoRoot);
  return {
    version: 2,
    canonicalTaskRoot: resolveCanonicalTaskRoot(canonicalMainWorktree),
    canonicalMainWorktree,
    gitCommonDir,
    repoInstanceId: buildRepoInstanceId(gitCommonDir),
    updatedAt: new Date(nowMs).toISOString(),
  };
}

function parseWorktreeRootOwnerRecord(
  raw: string,
  markerPath: string
): WorktreeRootOwnerRecord | null {
  try {
    const parsed = JSON.parse(raw) as Partial<
      WorktreeRootOwnerRecord & LegacyWorktreeRootOwnerRecord
    >;
    if (parsed?.version === 1) {
      const legacy = parsed as Partial<LegacyWorktreeRootOwnerRecord>;
      if (
        typeof legacy.canonicalMainWorktree !== "string" ||
        typeof legacy.gitCommonDir !== "string" ||
        typeof legacy.updatedAt !== "string"
      ) {
        fail(`invalid worktree root owner marker: ${markerPath}`);
      }
      const canonicalMainWorktree = canonicalPath(legacy.canonicalMainWorktree);
      const gitCommonDir = canonicalPath(legacy.gitCommonDir);
      return {
        version: 2,
        canonicalTaskRoot: resolveCanonicalTaskRoot(canonicalMainWorktree),
        canonicalMainWorktree,
        gitCommonDir,
        repoInstanceId: buildRepoInstanceId(gitCommonDir),
        updatedAt: legacy.updatedAt,
      };
    }
    if (
      parsed?.version !== 2 ||
      typeof parsed.canonicalTaskRoot !== "string" ||
      typeof parsed.canonicalMainWorktree !== "string" ||
      typeof parsed.gitCommonDir !== "string" ||
      typeof parsed.repoInstanceId !== "string" ||
      typeof parsed.updatedAt !== "string"
    ) {
      fail(`invalid worktree root owner marker: ${markerPath}`);
    }
    return {
      version: 2,
      canonicalTaskRoot: canonicalPath(parsed.canonicalTaskRoot),
      canonicalMainWorktree: canonicalPath(parsed.canonicalMainWorktree),
      gitCommonDir: canonicalPath(parsed.gitCommonDir),
      repoInstanceId: String(parsed.repoInstanceId),
      updatedAt: parsed.updatedAt,
    };
  } catch {
    fail(`invalid worktree root owner marker: ${markerPath}`);
  }
}

export function readWorktreeRootOwnerRecord(repoRoot: string): WorktreeRootOwnerRecord | null {
  const markerPath = resolveWorktreeRootOwnerMarkerPathFromRepoRoot(repoRoot);
  if (!existsSync(markerPath)) {
    return null;
  }
  return parseWorktreeRootOwnerRecord(readFileSync(markerPath, "utf8"), markerPath);
}

export function ensureCanonicalTaskRootOwnership(input: {
  nowMs?: number;
  repoRoot: string;
  writeIfMissing?: boolean;
}): WorktreeRootOwnerRecord {
  const expected = buildExpectedWorktreeRootOwnerRecord(input.repoRoot, input.nowMs);
  const markerPath = resolveWorktreeRootOwnerMarkerPath(expected.canonicalTaskRoot);
  const current = readWorktreeRootOwnerRecordForTaskRoot(expected.canonicalTaskRoot);

  if (current && current.gitCommonDir !== expected.gitCommonDir) {
    fail(
      `canonical task root ${path.dirname(markerPath)} is already owned by repo instance ${current.repoInstanceId} (${current.gitCommonDir}); current checkout is ${expected.repoInstanceId} (${expected.gitCommonDir}). Rescue or remove the foreign sibling clone/worktrees before reusing ../wt.`
    );
  }

  if (current && current.canonicalTaskRoot !== expected.canonicalTaskRoot) {
    fail(
      `canonical task root owner marker ${markerPath} points at ${current.canonicalTaskRoot}, but this checkout resolves ${expected.canonicalTaskRoot}. Recreate or repair sibling ../wt ownership before continuing.`
    );
  }

  if (!current && !input.writeIfMissing) {
    fail(
      `canonical task root ${path.dirname(markerPath)} is missing ownership metadata. Re-run the canonical worktree creation flow from the intended main checkout to initialize ../wt ownership.`
    );
  }

  const nextRecord =
    current && current.gitCommonDir === expected.gitCommonDir
      ? {
          version: 2 as const,
          canonicalTaskRoot: expected.canonicalTaskRoot,
          canonicalMainWorktree: expected.canonicalMainWorktree,
          gitCommonDir: expected.gitCommonDir,
          repoInstanceId: expected.repoInstanceId,
          updatedAt: expected.updatedAt,
        }
      : expected;

  if (
    input.writeIfMissing &&
    (!current ||
      current.canonicalTaskRoot !== nextRecord.canonicalTaskRoot ||
      current.canonicalMainWorktree !== nextRecord.canonicalMainWorktree ||
      current.gitCommonDir !== nextRecord.gitCommonDir ||
      current.repoInstanceId !== nextRecord.repoInstanceId)
  ) {
    mkdirSync(path.dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, `${JSON.stringify(nextRecord, null, 2)}\n`, "utf8");
  }

  return nextRecord;
}

export function listCanonicalTaskWorktrees(repoRoot: string): GitWorktreeEntry[] {
  const canonicalTaskRoot = resolveCanonicalTaskRootFromRepoRoot(repoRoot);
  return listGitWorktrees(repoRoot)
    .filter((worktree) => worktree.branch.startsWith("task/"))
    .filter((worktree) => path.dirname(worktree.path) === canonicalTaskRoot)
    .sort((left, right) => left.path.localeCompare(right.path));
}

function main(): void {
  const args = process.argv.slice(2);
  const command = String(args[0] || "").trim();
  if (command !== "ensure-root-owner") {
    fail(
      "Usage: bun platform/dev/worktree/worktree-topology.ts ensure-root-owner --repo-root <path> [--write]"
    );
  }

  let repoRoot = "";
  let writeIfMissing = false;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--repo-root":
        repoRoot = String(args[index + 1] || "").trim();
        if (!repoRoot) {
          fail("missing value for --repo-root");
        }
        index += 1;
        break;
      case "--write":
        writeIfMissing = true;
        break;
      default:
        fail(`unknown option: ${arg}`);
    }
  }

  if (!repoRoot) {
    fail("--repo-root is required");
  }

  const owner = ensureCanonicalTaskRootOwnership({ repoRoot, writeIfMissing });
  process.stdout.write(
    `[worktree-topology] ${resolveCanonicalTaskRootFromRepoRoot(repoRoot)} owner=${owner.repoInstanceId} git_common_dir=${owner.gitCommonDir}\n`
  );
}

if (import.meta.main) {
  main();
}
