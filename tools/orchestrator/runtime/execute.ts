#!/usr/bin/env bun

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  hasActiveForeignClaim,
  loadTaskIssues,
  sortIssuesForExecutionPlan,
  type TaskIssue,
  validateIssueGraph,
} from "../../core/task-governance";
import { collectTaskSizingCertificationReport } from "../../core/task-governance-certification";
import {
  GITHUB_RUN_CONTEXT_SCHEMA_VERSION,
  writeGithubRunContextFile,
} from "../shared/github_run_context";
import { appendRuntimeEvent } from "../shared/runtime_event_log";
import { acquireSessionWriterLock, withSessionWriterLockAsync } from "../shared/runtime_lifecycle";
import {
  buildSessionId as buildSharedSessionId,
  resolveDefaultWorktreeRoot,
  resolvePathInRepo,
  resolveRuntimeStateDir as resolveSharedRuntimeStateDir,
  resolveSessionId as resolveSharedSessionId,
  resolveStateBackend as resolveSharedStateBackend,
} from "../shared/runtime_policy";
import {
  resolveSessionArtifactPaths,
  writeSessionArtifactManifest,
} from "../shared/session_artifacts";
import { refreshSessionLock, releaseSessionLock } from "../shared/session_lock";
import {
  readSessionExecutionPlanArtifact,
  readSessionGithubRunContextArtifact,
} from "../shared/session_state";
import { compileExecutionPlan, type ExecutionPlan } from "./export-execution-plan";
import { ensureOrchestratorBinary, resolveOrchestratorBinaryPath } from "./rust-runtime";

type Command = "doctor" | "run";

type Cli = {
  command: Command;
  repository: string;
  issue: string;
  profile: string;
  stateDir: string;
  stateBackend: string;
  runIssue: string;
  taskSource: string;
  skillsConfig: string;
  allowDirtyBase: boolean;
  sessionId: string;
};

type SpawnedProcessResult = {
  exitCode: number;
  signal: NodeJS.Signals | null;
  pid: number | null;
};

type SpawnedProcessInfo = {
  pid: number | null;
  kill: (signal?: NodeJS.Signals) => void;
};

type RunChildProcessOptions = {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  onSpawn?: (processInfo: SpawnedProcessInfo) => void;
};

type RunExecuteCommandOptions = {
  repoRoot: string;
  orchestratorRoot: string;
  cli: Cli;
  heartbeatIntervalMs?: number;
  ensureOrchestratorBinaryImpl?: typeof ensureOrchestratorBinary;
  runDoctorImpl?: (repoRoot: string, orchestratorRoot: string, cli: Cli) => Promise<void> | void;
  runStateBootstrapImpl?: (repoRoot: string, cli: Cli) => Promise<void> | void;
  certifyTaskSizingImpl?: (input: {
    repository: string;
    sourcePath?: string;
  }) => Promise<void> | void;
  runChildProcess?: (options: RunChildProcessOptions) => Promise<SpawnedProcessResult>;
  appendRuntimeEventImpl?: typeof appendRuntimeEvent;
  refreshSessionLockImpl?: typeof refreshSessionLock;
};

const EXECUTE_HEARTBEAT_INTERVAL_MS = 5_000;

type CommandInvocation = {
  command: string;
  args: string[];
};

function usage(): string {
  return [
    "Usage:",
    "  bun execute.ts doctor --repository <owner/repo> --issue <number|url> [--profile <name>] [--state-backend <github|local>] [--state-dir <path>] [--task-source <issues.json>] [--skills-config <path>] [--allow-dirty-base] [--session-id <value>]",
    "  bun execute.ts run --repository <owner/repo> --issue <number|url> [--profile <name>] [--state-backend <github|local>] [--state-dir <path>] [--run-issue <number>] [--task-source <issues.json>] [--skills-config <path>] [--allow-dirty-base] [--session-id <value>]",
    "",
    "Notes:",
    "  - doctor compiles the execution plan, certifies task sizing, refreshes session artifacts, then exits.",
    "  - run mode executes doctor first (fail-closed), then runs the orchestrator.",
    "  - state-backend defaults to github.",
    "  - default state dir is deterministic: <repo_parent>/wt/.omta/state/sessions/<session-id>.",
    "  - session-id defaults to auto-generated value, is propagated to orchestrator runtime, and scopes the persisted execution-plan snapshot.",
  ].join("\n");
}

function fail(message: string): never {
  throw new Error(message);
}

function resolveRuntimeEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // biome-ignore lint/style/noProcessEnv: orchestration runtime must read the live process env at the CLI boundary when callers do not inject one.
  return env ?? process.env;
}

function run(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = resolveRuntimeEnv()
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
  baseEnv: NodeJS.ProcessEnv = resolveRuntimeEnv(),
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
    "repository",
    "issue",
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
    repository: (flags.get("repository") || "").trim(),
    issue: (flags.get("issue") || "").trim(),
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

function ensureRepository(value: string): string {
  const repository = value.trim();
  if (!/^[^/]+\/[^/]+$/.test(repository)) {
    fail("--repository is required and must be <owner>/<repo>");
  }
  return repository;
}

function normalizeIssueNumber(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) fail("--issue is required");
  const directMatch = trimmed.match(/^#?(\d+)$/);
  if (directMatch) {
    return Number(directMatch[1] || "0");
  }
  const urlMatch = trimmed.match(/\/issues\/(\d+)(?:\/)?$/);
  if (urlMatch) {
    return Number(urlMatch[1] || "0");
  }
  fail(`--issue must be an issue number or issue URL: ${value}`);
}

function readTrackedRepositoryFromExecutionPlan(stateDir: string): string {
  return readSessionExecutionPlanArtifact(stateDir)?.repository || "";
}

function emitSessionManifest(cli: Cli, command: "execute:doctor" | "execute:run"): void {
  const repository = readTrackedRepositoryFromExecutionPlan(cli.stateDir);
  if (!repository) return;

  const githubRunContext = readSessionGithubRunContextArtifact({
    stateDir: cli.stateDir,
    repository,
  });
  if (githubRunContext) {
    writeGithubRunContextFile({
      stateDir: cli.stateDir,
      context: {
        schema_version: GITHUB_RUN_CONTEXT_SCHEMA_VERSION,
        generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        repository: githubRunContext.repository,
        state_backend: "github",
        run_id: githubRunContext.run_id,
        run_issue_number: githubRunContext.run_issue_number,
        run_issue_url: githubRunContext.run_issue_url,
      },
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

export async function certifyTaskSizingForExecution(input: {
  repository: string;
  sourcePath?: string;
}): Promise<void> {
  const { issues } = await loadTaskIssues({
    repository: input.repository,
    sourcePath: input.sourcePath,
    state: "open",
  });
  const report = collectTaskSizingCertificationReport(issues);
  if (report.failing_task_count === 0) {
    return;
  }
  fail(
    `task sizing certification failed for open task issues: ${report.failing_tasks
      .map((entry) => {
        const normalizedTaskId = String(entry.task_id || "").trim();
        return normalizedTaskId
          ? `${normalizedTaskId} (#${entry.issue_number})`
          : `#${entry.issue_number}`;
      })
      .join(", ")}`
  );
}

async function writeExecutionPlanForIssue(cli: Cli): Promise<void> {
  const taskSource = cli.taskSource ? path.resolve(cli.taskSource) : undefined;
  const paths = resolveSessionArtifactPaths(cli.stateDir);
  if (!cli.issue.trim()) {
    if (existsSync(paths.executionPlanJson)) {
      return;
    }
    fail("--issue is required unless state dir already contains inputs/execution-plan.json");
  }
  const repository = ensureRepository(cli.repository);
  const selectedIssueNumber = normalizeIssueNumber(cli.issue);
  const { repository: repositoryRef, issues } = await loadTaskIssues({
    repository,
    sourcePath: taskSource,
    state: "open",
  });
  const ordered = sortIssuesForExecutionPlan(issues);
  const validation = validateIssueGraph(ordered);
  if (validation.errors.length > 0) {
    fail(
      `cannot export execution plan because issue graph validation failed:\n${validation.errors.join("\n")}`
    );
  }

  const executionPlan = buildExecutionPlanForIssue({
    issues: ordered,
    repositoryRef,
    selectedIssueNumber,
    sessionId: cli.sessionId,
  });

  mkdirSync(paths.inputsDir, { recursive: true });
  writeFileSync(paths.executionPlanJson, `${JSON.stringify(executionPlan, null, 2)}\n`, "utf8");
}

export function buildExecutionPlanForIssue(input: {
  issues: TaskIssue[];
  repositoryRef: { owner: string; repo: string };
  selectedIssueNumber: number;
  sessionId: string;
}): ExecutionPlan {
  const selectedIssue = input.issues.find((issue) => issue.number === input.selectedIssueNumber);
  if (!selectedIssue) {
    fail(`task issue #${input.selectedIssueNumber} is not available for execute`);
  }
  if (
    selectedIssue.metadata.status !== "ready" &&
    selectedIssue.metadata.status !== "in progress"
  ) {
    fail(
      `task issue #${input.selectedIssueNumber} must be status=ready or in progress for execute (actual: ${selectedIssue.metadata.status})`
    );
  }
  if (hasActiveForeignClaim(selectedIssue.metadata, { sessionId: input.sessionId })) {
    const owner = selectedIssue.metadata.claimed_by || "(unknown)";
    const lease = selectedIssue.metadata.lease_expires_at || "(missing)";
    fail(
      `task issue #${input.selectedIssueNumber} is claimed by another session: owner=${owner} lease_expires_at=${lease}`
    );
  }
  return compileExecutionPlan({
    issues: input.issues,
    repositoryRef: input.repositoryRef,
    baseBranch: "main",
    maxWorkers: 1,
    sessionId: input.sessionId,
    selectedIssueNumbers: [input.selectedIssueNumber],
  });
}

export function buildDoctorInvocation(
  repoRoot: string,
  cli: Cli,
  options: {
    binaryPath?: string;
  } = {}
): CommandInvocation {
  const binaryPath = options.binaryPath || resolveOrchestratorBinaryPath(repoRoot);
  const args = [
    "doctor",
    "--repo-root",
    repoRoot,
    "--state-dir",
    cli.stateDir,
    "--session-id",
    cli.sessionId,
    "--state-backend",
    resolveStateBackend(cli.stateBackend),
  ];
  if (cli.allowDirtyBase) {
    args.push("--allow-dirty-base");
  }
  return {
    command: binaryPath,
    args,
  };
}

export function buildRunInvocation(repoRoot: string, cli: Cli): CommandInvocation {
  const binaryPath = resolveOrchestratorBinaryPath(repoRoot);
  const args = [
    "run",
    "--repo-root",
    repoRoot,
    "--state-dir",
    cli.stateDir,
    "--session-id",
    cli.sessionId,
    "--state-backend",
    resolveStateBackend(cli.stateBackend),
  ];
  if (cli.profile) {
    args.push("--profile", cli.profile);
  }
  if (cli.skillsConfig) {
    const skillsConfig = path.resolve(cli.skillsConfig);
    if (!existsSync(skillsConfig)) {
      fail(`--skills-config file not found: ${cli.skillsConfig}`);
    }
    args.push("--skills-config", skillsConfig);
  }
  return {
    command: binaryPath,
    args,
  };
}

export function buildStateBootstrapInvocation(repoRoot: string, cli: Cli): CommandInvocation {
  const binaryPath = resolveOrchestratorBinaryPath(repoRoot);
  const args = [
    "state-bootstrap",
    "--repo-root",
    repoRoot,
    "--state-dir",
    cli.stateDir,
    "--session-id",
    cli.sessionId,
    "--state-backend",
    resolveStateBackend(cli.stateBackend),
  ];
  if (cli.runIssue) {
    args.push("--run-issue", cli.runIssue);
  }
  return {
    command: binaryPath,
    args,
  };
}

async function runDoctor(repoRoot: string, _orchestratorRoot: string, cli: Cli): Promise<void> {
  await writeExecutionPlanForIssue(cli);
  const binaryPath = ensureOrchestratorBinary({ repoRoot });
  const invocation = buildDoctorInvocation(repoRoot, cli);
  run(
    binaryPath,
    invocation.args,
    repoRoot,
    buildOrchestratorRuntimeEnv(
      repoRoot,
      {
        ...resolveRuntimeEnv(),
        ORCHESTRATE_REUSE_EXECUTION_PLAN: "1",
      },
      cli.sessionId
    )
  );
}

function runStateBootstrap(repoRoot: string, cli: Cli): void {
  const binaryPath = ensureOrchestratorBinary({ repoRoot });
  const invocation = buildStateBootstrapInvocation(repoRoot, cli);
  run(
    binaryPath,
    invocation.args,
    repoRoot,
    buildOrchestratorRuntimeEnv(
      repoRoot,
      {
        ...resolveRuntimeEnv(),
        ORCHESTRATE_REUSE_EXECUTION_PLAN: "1",
      },
      cli.sessionId
    )
  );
}

export function spawnChildProcess(options: RunChildProcessOptions): Promise<SpawnedProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: "inherit",
    });

    options.onSpawn?.({
      pid: child.pid ?? null,
      kill: (signal) => {
        child.kill(signal);
      },
    });

    const cleanupSignalHandlers: Array<() => void> = [];
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const handler = () => {
        try {
          child.kill(signal);
        } catch {
          // Best-effort forwarding only.
        }
      };
      process.on(signal, handler);
      cleanupSignalHandlers.push(() => process.off(signal, handler));
    }

    const cleanup = () => {
      for (const removeHandler of cleanupSignalHandlers) {
        removeHandler();
      }
    };

    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      resolve({
        exitCode: Number(code ?? (signal ? 1 : 0)),
        signal,
        pid: child.pid ?? null,
      });
    });
  });
}

export async function runExecuteCommandWithLifecycle(
  options: RunExecuteCommandOptions
): Promise<void> {
  const runDoctorImpl = options.runDoctorImpl || runDoctor;
  const runStateBootstrapImpl = options.runStateBootstrapImpl || runStateBootstrap;
  const ensureOrchestratorBinaryImpl =
    options.ensureOrchestratorBinaryImpl || ensureOrchestratorBinary;
  const certifyTaskSizingImpl = options.certifyTaskSizingImpl || certifyTaskSizingForExecution;
  const runChildProcess = options.runChildProcess || spawnChildProcess;
  const appendRuntimeEventImpl = options.appendRuntimeEventImpl || appendRuntimeEvent;
  const refreshSessionLockImpl = options.refreshSessionLockImpl || refreshSessionLock;
  const appendExecuteEvent = (eventType: string, payload?: Record<string, unknown>): void => {
    appendRuntimeEventImpl({
      stateDir: options.cli.stateDir,
      sessionId: options.cli.sessionId,
      eventType,
      payload,
    });
  };
  const certifyTaskSizing = async (): Promise<void> => {
    const repository = readTrackedRepositoryFromExecutionPlan(options.cli.stateDir);
    if (!repository) {
      fail("execution plan repository is missing; task sizing certification cannot proceed");
    }
    await certifyTaskSizingImpl({
      repository,
      sourcePath: options.cli.taskSource ? path.resolve(options.cli.taskSource) : undefined,
    });
    appendExecuteEvent("execute.task_sizing.certified", {
      repository,
    });
  };

  if (options.cli.command === "doctor") {
    return withSessionWriterLockAsync(
      {
        stateDir: options.cli.stateDir,
        sessionId: options.cli.sessionId,
        ownerLabel: "execute:doctor",
      },
      async () => {
        appendExecuteEvent("execute.command.started", {
          command: "doctor",
        });
        try {
          await runDoctorImpl(options.repoRoot, options.orchestratorRoot, options.cli);
          await certifyTaskSizing();
          emitSessionManifest(options.cli, "execute:doctor");
          appendExecuteEvent("execute.doctor.completed", {
            command: "doctor",
          });
          appendExecuteEvent("execute.command.completed", {
            command: "doctor",
          });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          appendExecuteEvent("execute.command.failed", {
            command: "doctor",
            error_message: detail,
          });
          throw error;
        }
      }
    );
  }

  const lock = acquireSessionWriterLock({
    stateDir: options.cli.stateDir,
    sessionId: options.cli.sessionId,
    ownerLabel: "execute:run",
  });
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? EXECUTE_HEARTBEAT_INTERVAL_MS;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatInFlight = false;
  let heartbeatError: Error | null = null;
  let orchestratorPid: number | null = null;
  let stopChild: ((signal?: NodeJS.Signals) => void) | null = null;
  let orchestratorStarted = false;
  let orchestratorTerminalEventRecorded = false;

  const stopHeartbeat = (): void => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  const failHeartbeat = (error: unknown): void => {
    if (heartbeatError) return;
    heartbeatError = error instanceof Error ? error : new Error(String(error));
    try {
      stopChild?.("SIGTERM");
    } catch {
      // Best-effort termination only.
    }
  };

  try {
    appendExecuteEvent("execute.command.started", {
      command: "run",
    });

    await runDoctorImpl(options.repoRoot, options.orchestratorRoot, options.cli);
    await certifyTaskSizing();
    emitSessionManifest(options.cli, "execute:doctor");
    appendExecuteEvent("execute.doctor.completed", {
      command: "run",
    });
    await runStateBootstrapImpl(options.repoRoot, options.cli);
    appendExecuteEvent("execute.state_bootstrap.completed", {
      command: "run",
    });

    const binaryPath = ensureOrchestratorBinaryImpl({
      repoRoot: options.repoRoot,
    });
    const invocation = buildRunInvocation(options.repoRoot, options.cli);
    const env = buildOrchestratorRuntimeEnv(
      options.repoRoot,
      {
        ...resolveRuntimeEnv(),
        ORCHESTRATE_REUSE_EXECUTION_PLAN: "1",
      },
      options.cli.sessionId
    );

    const orchestratorResultPromise = runChildProcess({
      command: binaryPath,
      args: invocation.args,
      cwd: options.repoRoot,
      env,
      onSpawn: ({ pid, kill }) => {
        orchestratorStarted = true;
        orchestratorPid = pid ?? null;
        stopChild = kill;
        appendExecuteEvent("execute.orchestrator.started", {
          pid: pid ?? 0,
        });

        heartbeatTimer = setInterval(() => {
          if (heartbeatInFlight) return;
          heartbeatInFlight = true;
          try {
            const refreshed = refreshSessionLockImpl({
              stateDir: options.cli.stateDir,
              lockToken: lock.lock_token,
            });
            appendExecuteEvent("execute.orchestrator.heartbeat", {
              pid: pid ?? 0,
              updated_at: refreshed.updated_at,
            });
          } catch (error) {
            failHeartbeat(error);
          } finally {
            heartbeatInFlight = false;
          }
        }, heartbeatIntervalMs);
      },
    });

    const result = await orchestratorResultPromise;
    stopHeartbeat();
    if (heartbeatError) {
      throw heartbeatError;
    }
    if (result.exitCode !== 0) {
      appendExecuteEvent("execute.orchestrator.failed", {
        exit_code: result.exitCode,
        signal: result.signal || "",
        pid: result.pid ?? 0,
      });
      orchestratorTerminalEventRecorded = true;
      fail(`orchestrator exited with code ${result.exitCode}`);
    }

    appendExecuteEvent("execute.orchestrator.completed", {
      exit_code: result.exitCode,
      pid: result.pid ?? 0,
    });
    orchestratorTerminalEventRecorded = true;
    emitSessionManifest(options.cli, "execute:run");
    appendExecuteEvent("execute.command.completed", {
      command: "run",
    });
  } catch (error) {
    stopHeartbeat();
    const failure = heartbeatError || (error instanceof Error ? error : new Error(String(error)));
    if (orchestratorStarted && !orchestratorTerminalEventRecorded) {
      appendExecuteEvent("execute.orchestrator.failed", {
        pid: orchestratorPid ?? 0,
        error_message: failure.message,
      });
      orchestratorTerminalEventRecorded = true;
    }
    appendExecuteEvent("execute.command.failed", {
      command: "run",
      error_message: failure.message,
    });
    throw failure;
  } finally {
    releaseSessionLock({
      stateDir: options.cli.stateDir,
      lockToken: lock.lock_token,
    });
  }
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  const repoRoot = resolveRepoRoot();
  const orchestratorRoot = path.join(repoRoot, "tools", "orchestrator", "orchestrate");
  if (!existsSync(orchestratorRoot)) {
    fail(`orchestrator root not found: ${orchestratorRoot}`);
  }

  const sessionId = resolveSessionId(
    cli.sessionId || String(resolveRuntimeEnv().ORCHESTRATE_SESSION_ID || "")
  );
  const stateDir = resolveRuntimeStateDir(repoRoot, cli.stateDir, sessionId);
  const runtimeCli: Cli = { ...cli, stateDir, sessionId };

  if (runtimeCli.command === "doctor") {
    await runExecuteCommandWithLifecycle({
      repoRoot,
      orchestratorRoot,
      cli: runtimeCli,
    });
    process.stdout.write("doctor passed\n");
    return;
  }

  if (runtimeCli.command === "run") {
    await runExecuteCommandWithLifecycle({
      repoRoot,
      orchestratorRoot,
      cli: runtimeCli,
    });
    return;
  }
  fail(`unsupported command: ${runtimeCli.command}`);
}

if (import.meta.main) {
  await main().catch((error) => {
    process.stderr.write(`execute failed: ${(error as Error).message}\n`);
    process.exit(1);
  });
}
