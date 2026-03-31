#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  buildGithubRunContextFromStateArtifact,
  writeGithubRunContextFile,
} from "../../../../tools/orchestrator/shared/github_run_context";
import {
  buildSessionId as buildSharedSessionId,
  resolveDefaultWorktreeRoot,
  resolvePathInRepo,
  resolveRuntimeStateDir as resolveSharedRuntimeStateDir,
  resolveSessionId as resolveSharedSessionId,
  resolveStateBackend as resolveSharedStateBackend,
} from "../../../../tools/orchestrator/shared/runtime_policy";
import {
  resolveSessionArtifactPaths,
  writeSessionArtifactManifest,
} from "../../../../tools/orchestrator/shared/session_artifacts";

type Command = "doctor" | "run";

type Cli = {
  command: Command;
  profile: string;
  stateDir: string;
  stateBackend: string;
  runIssue: string;
  taskSource: string;
  skillsConfig: string;
  allowDirtyBase: boolean;
  sessionId: string;
};

function usage(): string {
  return [
    "Usage:",
    "  bun execute_runtime.ts doctor [--profile <name>] [--state-backend <github|local>] [--state-dir <path>] [--task-source <issues.json>] [--skills-config <path>] [--allow-dirty-base] [--session-id <value>]",
    "  bun execute_runtime.ts run [--profile <name>] [--state-backend <github|local>] [--state-dir <path>] [--run-issue <number>] [--task-source <issues.json>] [--skills-config <path>] [--allow-dirty-base] [--session-id <value>]",
    "",
    "Notes:",
    "  - doctor compiles and validates the execution plan from GitHub task issues, then exits.",
    "  - run mode executes doctor first (fail-closed), then runs the orchestrator.",
    "  - state-backend defaults to github.",
    "  - default state dir is deterministic: <repo_parent>/wt/.omta/state/sessions/<session-id>.",
    "  - session-id defaults to auto-generated value, is propagated to orchestrator runtime, and scopes the persisted execution plan snapshot.",
  ].join("\n");
}

function fail(message: string): never {
  throw new Error(message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function run(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const detail = `${result.stderr || ""}\n${result.stdout || ""}`.trim();
    fail(`${command} ${args.join(" ")} failed: ${detail || `exit=${result.status}`}`);
  }
  return String(result.stdout || "").trim();
}

export function buildSessionId(now: Date = new Date()): string {
  return buildSharedSessionId(now);
}

export function resolveSessionId(value: string, fallback: string = buildSessionId()): string {
  return resolveSharedSessionId(value, {
    fallback,
    normalizeCase: true,
  });
}

export function resolveStateBackend(value: string): "github" | "local" {
  return resolveSharedStateBackend(value);
}

export function resolveRuntimeStateDir(
  repoRoot: string,
  inputStateDir: string,
  sessionId: string
): string {
  return resolveSharedRuntimeStateDir(repoRoot, inputStateDir, sessionId);
}

export function buildOrchestratorRuntimeEnv(
  repoRoot: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
  sessionId = ""
): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  const resolvedSessionId = resolveSessionId(
    sessionId || String(env.ORCHESTRATE_SESSION_ID || "").trim()
  );
  env.ORCHESTRATE_SESSION_ID = resolvedSessionId;
  const tmpRootRaw = (
    env.ORCHESTRATE_TMPDIR ||
    path.join(
      resolveDefaultWorktreeRoot(repoRoot),
      ".omta",
      "tmp",
      "orchestrator",
      resolvedSessionId
    )
  ).trim();
  const tmpRoot = resolvePathInRepo(repoRoot, tmpRootRaw);
  const tmpDir = resolvePathInRepo(repoRoot, (env.TMPDIR || tmpRoot).trim());
  const bunTmp = resolvePathInRepo(repoRoot, (env.BUN_TMPDIR || path.join(tmpRoot, "bun")).trim());
  const npmTmp = resolvePathInRepo(
    repoRoot,
    (env.npm_config_tmp || path.join(tmpRoot, "npm")).trim()
  );

  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(bunTmp, { recursive: true });
  mkdirSync(npmTmp, { recursive: true });

  env.TMPDIR = tmpDir;
  if (!String(env.TMP || "").trim()) env.TMP = env.TMPDIR;
  if (!String(env.TEMP || "").trim()) env.TEMP = env.TMPDIR;
  env.BUN_TMPDIR = bunTmp;
  env.npm_config_tmp = npmTmp;
  if (!String(env.OMTA_SKIP_GIT_HOOKS || "").trim()) env.OMTA_SKIP_GIT_HOOKS = "1";
  return env;
}

function parseCli(argv: string[]): Cli {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }

  const commandRaw = argv[0]?.trim() || "";
  if (commandRaw !== "doctor" && commandRaw !== "run") {
    fail(`unknown command: ${commandRaw}`);
  }

  const flags = new Map<string, string>();
  let allowDirtyBase = false;
  const allowedFlags = new Set([
    "profile",
    "state-backend",
    "state-dir",
    "run-issue",
    "task-source",
    "skills-config",
    "allow-dirty-base",
    "session-id",
  ]);

  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i] ?? "";
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
    command: commandRaw,
    profile: (flags.get("profile") || "").trim(),
    stateDir: (flags.get("state-dir") || "").trim(),
    stateBackend: (flags.get("state-backend") || "").trim(),
    runIssue: (flags.get("run-issue") || "").trim(),
    taskSource: (flags.get("task-source") || "").trim(),
    skillsConfig: (flags.get("skills-config") || "").trim(),
    allowDirtyBase,
    sessionId: (flags.get("session-id") || "").trim(),
  };
}

function resolveRepoRoot(): string {
  const root = run("git", ["rev-parse", "--show-toplevel"], process.cwd()).trim();
  if (!root) fail("failed to resolve repository root");
  return root;
}

function readTrackedRepositoryFromExecutionPlan(stateDir: string): string {
  const executionPlanPath = resolveSessionArtifactPaths(stateDir).executionPlanJson;
  if (!existsSync(executionPlanPath)) return "";

  const raw = JSON.parse(readFileSync(executionPlanPath, "utf8")) as unknown;
  if (!isObject(raw) || !isObject(raw.issue_tracking)) return "";
  return String(raw.issue_tracking.repository || "").trim();
}

function emitSessionManifest(cli: Cli, command: "execute:doctor" | "execute:run"): void {
  const repository = readTrackedRepositoryFromExecutionPlan(cli.stateDir);
  if (!repository) return;

  const githubRunContext = buildGithubRunContextFromStateArtifact({
    stateDir: cli.stateDir,
    repository,
  });
  if (githubRunContext) {
    writeGithubRunContextFile({
      stateDir: cli.stateDir,
      context: githubRunContext,
    });
  }

  writeSessionArtifactManifest({
    stateDir: cli.stateDir,
    sessionId: cli.sessionId,
    stateBackend: resolveStateBackend(cli.stateBackend),
    repository,
    command,
  });
}

function buildOrchestratorArgs(cli: Cli): string[] {
  const args: string[] = [];
  const stateBackend = resolveStateBackend(cli.stateBackend);
  args.push("--state-backend", stateBackend);
  if (cli.profile) args.push("--profile", cli.profile);
  if (cli.stateDir) args.push("--state-dir", path.resolve(cli.stateDir));
  if (cli.runIssue) args.push("--run-issue", cli.runIssue);
  if (cli.taskSource) {
    const taskSource = path.resolve(cli.taskSource);
    if (!existsSync(taskSource)) {
      fail(`--task-source file not found: ${cli.taskSource}`);
    }
    // Python orchestrator runtime still consumes --issue-source.
    args.push("--issue-source", taskSource);
  }
  if (cli.skillsConfig) {
    const skillsConfig = path.resolve(cli.skillsConfig);
    if (!existsSync(skillsConfig)) {
      fail(`--skills-config file not found: ${cli.skillsConfig}`);
    }
    args.push("--skills-config", skillsConfig);
  }
  if (cli.allowDirtyBase) {
    args.push("--allow-dirty-base");
  }
  if (cli.sessionId) {
    args.push("--session-id", cli.sessionId);
  }
  return args;
}

function runDoctor(repoRoot: string, orchestratorRoot: string, cli: Cli): void {
  const args = [
    path.join(orchestratorRoot, "orchestrate_dag.py"),
    ...buildOrchestratorArgs(cli),
    "--doctor",
  ];
  run("python3", args, repoRoot, buildOrchestratorRuntimeEnv(repoRoot, process.env, cli.sessionId));
}

function runOrchestrator(repoRoot: string, orchestratorRoot: string, cli: Cli): void {
  const args = [path.join(orchestratorRoot, "orchestrate_dag.py"), ...buildOrchestratorArgs(cli)];
  const env = buildOrchestratorRuntimeEnv(repoRoot, process.env, cli.sessionId);

  // Use stdio: "inherit" so the orchestrator child process shares the
  // parent's terminal/signal group.  This ensures SIGINT / SIGTERM
  // propagate to the Python orchestrator, letting it run its own
  // graceful-shutdown (finally) block instead of being orphaned.
  const result = spawnSync("python3", args, {
    cwd: repoRoot,
    env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    fail(`orchestrator exited with code ${result.status ?? "unknown"}`);
  }
}

function main(): void {
  const cli = parseCli(process.argv.slice(2));
  const repoRoot = resolveRepoRoot();
  const orchestratorRoot = path.join(repoRoot, "tools", "orchestrator", "orchestrate");
  if (!existsSync(orchestratorRoot)) {
    fail(`orchestrator root not found: ${orchestratorRoot}`);
  }

  const sessionId = resolveSessionId(
    cli.sessionId || String(process.env.ORCHESTRATE_SESSION_ID || "")
  );
  const stateDir = resolveRuntimeStateDir(repoRoot, cli.stateDir, sessionId);
  const runtimeCli: Cli = { ...cli, stateDir, sessionId };

  if (runtimeCli.command === "doctor") {
    runDoctor(repoRoot, orchestratorRoot, runtimeCli);
    emitSessionManifest(runtimeCli, "execute:doctor");
    console.log("doctor passed");
    return;
  }

  if (runtimeCli.command === "run") {
    runDoctor(repoRoot, orchestratorRoot, runtimeCli);
    emitSessionManifest(runtimeCli, "execute:doctor");
    runOrchestrator(repoRoot, orchestratorRoot, runtimeCli);
    emitSessionManifest(runtimeCli, "execute:run");
    return;
  }
  fail(`unsupported command: ${runtimeCli.command}`);
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(`execute_runtime failed: ${(error as Error).message}`);
    process.exit(1);
  }
}
