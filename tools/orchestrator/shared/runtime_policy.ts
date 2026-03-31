import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { SESSION_ID_PATTERN } from "../../core/task-governance";

function resolveCanonicalTaskRootFromRepoRoot(repoRoot: string): string {
  const candidate = path.join(repoRoot, "..", "wt");
  try {
    return realpathSync.native(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

export type StateBackend = "github" | "local";

type ResolveSessionIdOptions = {
  envValue?: string;
  fallback?: string;
  normalizeCase?: boolean;
  requiredMessage?: string;
};

type ResolveRuntimeStateDirOptions = {
  create?: boolean;
  env?: NodeJS.ProcessEnv;
};

function fail(message: string): never {
  throw new Error(message);
}

function resolveRuntimeEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // biome-ignore lint/style/noProcessEnv: orchestration runtime must read the live process env when callers do not inject one.
  return env ?? process.env;
}

function runGit(repoRoot: string, args: string[], env?: NodeJS.ProcessEnv): string {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    env: resolveRuntimeEnv(env),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const detail = `${result.stderr || ""}\n${result.stdout || ""}`.trim();
    fail(`git ${args.join(" ")} failed: ${detail || `exit=${result.status}`}`);
  }
  return String(result.stdout || "").trim();
}

export function buildSessionId(now: Date = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z")
    .replace("T", "")
    .replace("Z", "")
    .slice(0, 14);
  const random = Math.random().toString(16).slice(2, 10).padEnd(8, "0").slice(0, 8);
  return `sess-${stamp}-${random}`;
}

export function resolveSessionId(value: string, options: ResolveSessionIdOptions = {}): string {
  const requested = String(value || "").trim();
  const envValue = String(options.envValue || "").trim();
  const fallback = String(options.fallback || "").trim();
  let candidate = requested || envValue || fallback;

  if (!candidate) {
    fail(options.requiredMessage || "failed to resolve orchestration session id");
  }
  if (options.normalizeCase) {
    candidate = candidate.toLowerCase();
  }
  if (!SESSION_ID_PATTERN.test(candidate)) {
    fail(
      `invalid session id: ${candidate} (allowed: lowercase [a-z0-9._-], length 6-81, must start with [a-z0-9])`
    );
  }
  return candidate;
}

export function resolveStateBackend(value: string): StateBackend {
  const text = value.trim().toLowerCase();
  if (!text) return "github";
  if (text === "github" || text === "local") return text;
  fail("--state-backend must be one of: github, local");
}

export function resolvePathInRepo(repoRoot: string, value: string): string {
  if (path.isAbsolute(value)) return value;
  return path.resolve(repoRoot, value);
}

export function resolveDefaultWorktreeRoot(repoRoot: string): string {
  return resolveCanonicalTaskRootFromRepoRoot(repoRoot);
}

export function resolveStateDirForSession(repoRoot: string, sessionId: string): string {
  return path.resolve(
    resolveDefaultWorktreeRoot(repoRoot),
    ".omta",
    "state",
    "sessions",
    sessionId
  );
}

function pathIsWithin(targetPath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function resolveGitCommonDir(repoRoot: string, env?: NodeJS.ProcessEnv): string {
  const raw = runGit(repoRoot, ["rev-parse", "--git-common-dir"], env);
  if (!raw) fail("failed to resolve git common dir");
  return resolvePathInRepo(repoRoot, raw);
}

export function enforceStateDirPolicy(
  repoRoot: string,
  stateDir: string,
  env?: NodeJS.ProcessEnv
): string {
  const resolvedStateDir = path.resolve(stateDir);
  const gitCommonDir = resolveGitCommonDir(repoRoot, env);
  if (pathIsWithin(resolvedStateDir, gitCommonDir)) {
    fail(`--state-dir must not be under git common dir (${gitCommonDir}): ${resolvedStateDir}`);
  }
  const worktreeRoot = resolveDefaultWorktreeRoot(repoRoot);
  if (!pathIsWithin(resolvedStateDir, worktreeRoot)) {
    fail(`--state-dir must be under ${worktreeRoot}: ${resolvedStateDir}`);
  }
  return resolvedStateDir;
}

export function resolveRuntimeStateDir(
  repoRoot: string,
  inputStateDir: string,
  sessionId: string,
  options: ResolveRuntimeStateDirOptions = {}
): string {
  const text = inputStateDir.trim();
  const stateDir = text ? path.resolve(text) : resolveStateDirForSession(repoRoot, sessionId);
  const validated = enforceStateDirPolicy(repoRoot, stateDir, options.env);
  if (options.create !== false) {
    mkdirSync(validated, { recursive: true });
  }
  return validated;
}
