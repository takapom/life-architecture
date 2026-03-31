import { spawnSync } from "node:child_process";

import {
  normalizeTmuxSessionName,
  resolveRuntimeStateDir,
  resolveSessionId,
} from "../orchestrator-tmux";
import { buildSessionId } from "./runtime_policy";

export type Command = "start" | "status" | "attach" | "resume" | "close";

export type Cli = {
  command: Command;
  repository: string;
  issue: string;
  parentIssue: string;
  stateBackend: string;
  stateDir: string;
  sessionId: string;
  taskSource: string;
  skillsConfig: string;
  profile: string;
  allowDirtyBase: boolean;
  runIssue: string;
  runId: string;
  baseBranch: string;
  tmuxSession: string;
};

function fail(message: string): never {
  throw new Error(message);
}

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const detail = `${result.stderr || ""}\n${result.stdout || ""}`.trim();
    fail(`${command} ${args.join(" ")} failed: ${detail || `exit=${result.status}`}`);
  }
  return String(result.stdout || "").trim();
}

export function usage(): string {
  return [
    "Usage:",
    "  bun run orchestrator:start -- --repository <owner/repo> [--issue <number|url>] [--state-backend <github|local>] [--state-dir <path>] [--session-id <value>] [--task-source <issues.json>] [--skills-config <path>] [--profile <name>] [--allow-dirty-base]",
    "  bun run orchestrator:status -- [--session-id <value>] [--state-dir <path>] [--tmux-session <name>]",
    "  bun run orchestrator:attach -- [--session-id <value>] [--state-dir <path>] [--tmux-session <name>]",
    "  bun run orchestrator:resume -- --repository <owner/repo> [--issue <number|url>] [--state-backend <github|local>] [--state-dir <path>] [--session-id <value>] [--task-source <issues.json>] [--skills-config <path>] [--profile <name>] [--allow-dirty-base]",
    "  bun run orchestrator:close -- --repository <owner/repo> [--state-backend <github|local>] [--state-dir <path>] [--session-id <value>] [--run-issue <number>] [--run-id <value>] [--base-branch <name>]",
    "",
    "Notes:",
    "  - start/resume delegate directly to the canonical execute runtime.",
    "  - --issue is the canonical execution selector for start/resume.",
    "  - parent issues are tracking-only once work is decomposed and are not valid start/resume selectors.",
    "  - attach delegates to the tmux viewport adapter.",
    "  - close delegates directly to the canonical close runtime and keeps remote task/parent sync explicit-only.",
    "  - status reads the canonical runtime projection (event log + session lock + session artifacts, including adapter-owned child execution artifacts) and does not treat tmux output as source of truth.",
  ].join("\n");
}

export function resolveRepoRoot(): string {
  const repoRoot = run("git", ["rev-parse", "--show-toplevel"], process.cwd());
  if (!repoRoot) fail("failed to resolve repository root");
  return repoRoot;
}

export function parseCli(argv: string[]): Cli {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }

  const command = String(argv[0] || "").trim();
  if (
    command !== "start" &&
    command !== "status" &&
    command !== "attach" &&
    command !== "resume" &&
    command !== "close"
  ) {
    fail(`unknown command: ${command}`);
  }

  const allowedFlags = new Set([
    "repository",
    "issue",
    "parent-issue",
    "state-backend",
    "state-dir",
    "session-id",
    "task-source",
    "skills-config",
    "profile",
    "allow-dirty-base",
    "run-issue",
    "run-id",
    "base-branch",
    "tmux-session",
  ]);

  const flags = new Map<string, string>();
  let allowDirtyBase = false;

  for (let i = 1; i < argv.length; i += 1) {
    const token = String(argv[i] || "");
    if (token === "--allow-dirty-base") {
      allowDirtyBase = true;
      continue;
    }
    if (!token.startsWith("--")) {
      fail(`unexpected positional argument: ${token}`);
    }
    const key = token.slice(2);
    if (!allowedFlags.has(key)) {
      fail(`unknown option: --${key}`);
    }
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      fail(`--${key} requires a value`);
    }
    flags.set(key, value);
    i += 1;
  }

  return {
    command,
    repository: String(flags.get("repository") || "").trim(),
    issue: String(flags.get("issue") || "").trim(),
    parentIssue: String(flags.get("parent-issue") || "").trim(),
    stateBackend: String(flags.get("state-backend") || "").trim(),
    stateDir: String(flags.get("state-dir") || "").trim(),
    sessionId: String(flags.get("session-id") || "").trim(),
    taskSource: String(flags.get("task-source") || "").trim(),
    skillsConfig: String(flags.get("skills-config") || "").trim(),
    profile: String(flags.get("profile") || "").trim(),
    allowDirtyBase,
    runIssue: String(flags.get("run-issue") || "").trim(),
    runId: String(flags.get("run-id") || "").trim(),
    baseBranch: String(flags.get("base-branch") || "").trim(),
    tmuxSession: String(flags.get("tmux-session") || "").trim(),
  };
}

export function resolveRuntimeCli(repoRoot: string, cli: Cli): Cli {
  if (cli.command === "status" || cli.command === "attach") {
    const sessionId = resolveSessionId(cli.sessionId, cli.stateDir);
    return {
      ...cli,
      sessionId,
      stateDir: resolveRuntimeStateDir(repoRoot, cli.stateDir, sessionId),
      tmuxSession:
        cli.command === "attach"
          ? normalizeTmuxSessionName(sessionId, cli.tmuxSession)
          : cli.tmuxSession,
    };
  }

  const sessionId = resolveSessionId(cli.sessionId, cli.stateDir, buildSessionId());
  return {
    ...cli,
    sessionId,
    stateDir: resolveRuntimeStateDir(repoRoot, cli.stateDir, sessionId),
  };
}
