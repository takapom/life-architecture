#!/usr/bin/env bun

import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";

const NON_INTERACTIVE_ENV = {
  GCM_INTERACTIVE: "never",
  GIT_ASKPASS: "/bin/echo",
  GIT_SSH_COMMAND: "ssh -oBatchMode=yes",
  GIT_TERMINAL_PROMPT: "0",
  SSH_ASKPASS: "/bin/echo",
} as const;

type GitRemoteAuthContext = {
  env: NodeJS.ProcessEnv;
  remoteUrl: string;
  usesGitHubToken: boolean;
};

type ResolveGitRemoteAuthContextOptions = {
  env?: NodeJS.ProcessEnv;
  remote?: string;
  repoRoot: string;
};

type Cli = {
  command: string[];
  remote: string;
  repoRoot: string;
};

function usage(): string {
  return `Usage:
  bun tools/orchestrator/pr/git-remote-auth.ts --repo-root <path> [--remote <name>] -- <command> [args...]

Options:
  --repo-root <path>  Repository checkout used to resolve the remote URL
  --remote <name>     Remote name to authenticate against (default: origin)
  --help              Show this help`;
}

function isGitHubRemote(remoteUrl: string): boolean {
  return (
    /^git@github\.com:/i.test(remoteUrl) ||
    /^ssh:\/\/git@github\.com\//i.test(remoteUrl) ||
    /^https:\/\/github\.com\//i.test(remoteUrl)
  );
}

function resolveGitHubToken(env: NodeJS.ProcessEnv): string {
  const envToken = env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim();
  if (envToken) {
    return envToken;
  }

  try {
    const token = execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (token) {
      return token;
    }
  } catch {
    // fall through
  }

  throw new Error(
    "GitHub token was not found. Set GITHUB_TOKEN (or GH_TOKEN) or run `gh auth login` first."
  );
}

function appendGitConfigEntries(
  env: NodeJS.ProcessEnv,
  entries: ReadonlyArray<readonly [key: string, value: string]>
): NodeJS.ProcessEnv {
  const nextEnv: NodeJS.ProcessEnv = { ...env };
  const existingCountRaw = String(env.GIT_CONFIG_COUNT || "").trim();
  const existingCount = existingCountRaw ? Number.parseInt(existingCountRaw, 10) : 0;

  if (!Number.isSafeInteger(existingCount) || existingCount < 0) {
    throw new Error(`invalid GIT_CONFIG_COUNT value: ${existingCountRaw || "(empty)"}`);
  }

  let index = existingCount;
  for (const [key, value] of entries) {
    nextEnv[`GIT_CONFIG_KEY_${index}`] = key;
    nextEnv[`GIT_CONFIG_VALUE_${index}`] = value;
    index += 1;
  }

  nextEnv.GIT_CONFIG_COUNT = String(index);
  return nextEnv;
}

function buildGitHubConfigEntries(token: string): ReadonlyArray<readonly [string, string]> {
  const authHeader = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`, "utf8").toString("base64")}`;
  return [
    ["credential.helper", ""],
    ["url.https://github.com/.insteadOf", "git@github.com:"],
    ["url.https://github.com/.insteadOf", "ssh://git@github.com/"],
    ["http.https://github.com/.extraheader", authHeader],
  ] as const;
}

export function summarizeGitRemoteAuthEnv(env: NodeJS.ProcessEnv): string[] {
  const summary = [
    `GIT_TERMINAL_PROMPT=${env.GIT_TERMINAL_PROMPT || ""}`,
    `GCM_INTERACTIVE=${env.GCM_INTERACTIVE || ""}`,
    `GIT_ASKPASS=${env.GIT_ASKPASS || ""}`,
    `SSH_ASKPASS=${env.SSH_ASKPASS || ""}`,
    `GIT_SSH_COMMAND=${env.GIT_SSH_COMMAND || ""}`,
  ];

  const count = Number.parseInt(String(env.GIT_CONFIG_COUNT || "0"), 10);
  if (Number.isSafeInteger(count) && count > 0) {
    for (let index = 0; index < count; index += 1) {
      const key = String(env[`GIT_CONFIG_KEY_${index}`] || "");
      if (!key) {
        continue;
      }
      const rawValue = String(env[`GIT_CONFIG_VALUE_${index}`] || "");
      const value = key.includes(".extraheader") ? "<redacted>" : rawValue;
      summary.push(`${key}=${value}`);
    }
  }

  return summary;
}

export function buildGitRemoteAuthContext(
  remoteUrl: string,
  env: NodeJS.ProcessEnv = Bun.env
): GitRemoteAuthContext {
  let authEnv: NodeJS.ProcessEnv = {
    ...env,
    ...NON_INTERACTIVE_ENV,
  };

  const usesGitHubToken = isGitHubRemote(remoteUrl);
  if (usesGitHubToken) {
    authEnv = appendGitConfigEntries(authEnv, buildGitHubConfigEntries(resolveGitHubToken(env)));
  }

  return {
    env: authEnv,
    remoteUrl,
    usesGitHubToken,
  };
}

function readRemoteUrl(repoRoot: string, remote: string, env: NodeJS.ProcessEnv): string {
  try {
    return execFileSync("git", ["-C", repoRoot, "remote", "get-url", remote], {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const detail =
      error && typeof error === "object" && "stderr" in error
        ? String((error as { stderr?: unknown }).stderr || "").trim()
        : "";
    throw new Error(
      `git remote get-url ${remote} failed: ${detail || (error as Error).message || "unknown error"}`
    );
  }
}

export function resolveGitRemoteAuthContext({
  repoRoot,
  remote = "origin",
  env = Bun.env,
}: ResolveGitRemoteAuthContextOptions): GitRemoteAuthContext {
  const remoteUrl = readRemoteUrl(path.resolve(repoRoot), remote, env);
  return buildGitRemoteAuthContext(remoteUrl, env);
}

export function runCommandWithGitRemoteAuth({
  repoRoot,
  remote = "origin",
  command,
  env = Bun.env,
}: ResolveGitRemoteAuthContextOptions & { command: string[] }): number {
  if (command.length === 0) {
    throw new Error("a command is required after --");
  }

  const context = resolveGitRemoteAuthContext({ repoRoot, remote, env });
  const [executable, ...args] = command;
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    env: context.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  return result.status ?? 1;
}

function parseCli(argv: string[]): Cli {
  let repoRoot = "";
  let remote = "origin";
  let command: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--") {
      command = argv.slice(index + 1);
      break;
    }
    if (value === "--help" || value === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (value === "--repo-root") {
      repoRoot = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (value === "--remote") {
      remote = String(argv[index + 1] || "").trim() || "origin";
      index += 1;
      continue;
    }
    throw new Error(`unknown option: ${value}`);
  }

  if (!repoRoot) {
    throw new Error("--repo-root is required");
  }
  if (command.length === 0) {
    throw new Error("a command is required after --");
  }

  return {
    command,
    remote,
    repoRoot,
  };
}

function main(): void {
  const cli = parseCli(process.argv.slice(2));
  const status = runCommandWithGitRemoteAuth(cli);
  process.exit(status);
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`[git-remote-auth] ERROR: ${(error as Error).message}\n`);
    process.exit(1);
  });
}
