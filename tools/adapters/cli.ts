import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export type JsonObject = Record<string, unknown>;
export const GH_TRANSIENT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000] as const;
export const GH_COMMAND_TIMEOUT_MS = 30_000;

export function fail(message: string): never {
  throw new Error(message);
}

export function renderStopReasonToken(stopReason: string): string {
  return `stop_reason=${String(stopReason || "").trim()}`;
}

export function renderStopReasonDiagnostic(stopReason: string, message: string): string {
  return `[${renderStopReasonToken(stopReason)}] ${String(message || "").trim()}`;
}

export function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseJson(text: string, source: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    fail(`invalid JSON (${source}): ${(error as Error).message}`);
  }
}

export function sleepSync(milliseconds: number): void {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    return;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.trunc(milliseconds));
}

export function isTransientGhFailureDetail(detail: string): boolean {
  const normalized = detail.toLowerCase();
  return (
    normalized.includes("http 500") ||
    normalized.includes("http 502") ||
    normalized.includes("http 503") ||
    normalized.includes("http 504") ||
    normalized.includes("gateway timeout") ||
    normalized.includes("timed out") ||
    normalized.includes("timeout") ||
    normalized.includes("econnreset") ||
    normalized.includes("connection reset") ||
    normalized.includes("temporarily unavailable")
  );
}

export function runGh(args: string[], options?: { cwd?: string }): string {
  let lastDetail = "";
  let lastStatus = 0;
  // biome-ignore lint/style/noProcessEnv: repo tooling resolves the gh binary from the process environment.
  const ghBin = process.env.OMTA_GH_BIN?.trim() || "gh";

  for (let attempt = 0; attempt <= GH_TRANSIENT_RETRY_DELAYS_MS.length; attempt += 1) {
    const result = spawnSync(ghBin, args, {
      cwd: options?.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: GH_COMMAND_TIMEOUT_MS,
    });
    if (result.status === 0) {
      return String(result.stdout || "").trim();
    }

    const detail = `${result.stderr || ""}\n${result.stdout || ""}`.trim();
    lastDetail = detail;
    lastStatus = result.status ?? 0;
    if (attempt === GH_TRANSIENT_RETRY_DELAYS_MS.length || !isTransientGhFailureDetail(detail)) {
      break;
    }
    sleepSync(GH_TRANSIENT_RETRY_DELAYS_MS[attempt] || 0);
  }

  fail(`${ghBin} ${args.join(" ")} failed: ${lastDetail || `exit=${lastStatus}`}`);
}

export function writeOutput(outputPath: string, payload: unknown): void {
  if (!outputPath.trim()) return;
  const absolute = path.resolve(outputPath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export function resolveRepoRoot(): string {
  const discoveredRoot = findRepoRoot(process.cwd());
  if (discoveredRoot) {
    maybeSelfHealBaseWorktreeConfig(discoveredRoot);
    return discoveredRoot;
  }

  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const detail = `${result.stderr || ""}\n${result.stdout || ""}`.trim();
    fail(`git rev-parse --show-toplevel failed: ${detail || `exit=${result.status}`}`);
  }
  const root = String(result.stdout || "").trim();
  if (!root) {
    fail("failed to resolve repository root");
  }
  return canonicalMaybe(root);
}

function findRepoRoot(startPath: string): string | null {
  let current = canonicalMaybe(startPath);
  if (!statSafe(current)?.isDirectory()) {
    current = path.dirname(current);
  }

  while (true) {
    if (existsSync(path.join(current, ".git"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function maybeSelfHealBaseWorktreeConfig(repoRoot: string): void {
  const gitDir = path.join(repoRoot, ".git");
  const gitDirStat = statSafe(gitDir);
  if (!gitDirStat?.isDirectory()) {
    return;
  }

  const configuredWorktree = spawnSync(
    "git",
    ["-C", repoRoot, "config", "--local", "--get", "core.worktree"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  if (configuredWorktree.status !== 0) {
    return;
  }

  const rawValue = String(configuredWorktree.stdout || "").trim();
  if (!rawValue) {
    return;
  }

  const resolvedWorktree = canonicalMaybe(
    path.isAbsolute(rawValue) ? rawValue : path.join(repoRoot, rawValue)
  );
  if (resolvedWorktree === canonicalMaybe(repoRoot)) {
    return;
  }

  spawnSync("git", ["-C", repoRoot, "config", "--local", "--unset-all", "core.worktree"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function statSafe(targetPath: string) {
  try {
    return statSync(targetPath);
  } catch {
    return null;
  }
}

function canonicalMaybe(targetPath: string): string {
  try {
    return realpathSync.native(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}
