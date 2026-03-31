#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { loadTaskIssues } from "../../../../tools/core/issue-graph";
import type { TaskIssue } from "../../../../tools/core/issue-graph-types";
import {
  buildSessionId as buildSharedSessionId,
  resolveRuntimeStateDir as resolveSharedRuntimeStateDir,
  resolveSessionId as resolveSharedSessionId,
  resolveStateBackend as resolveSharedStateBackend,
} from "../../../../tools/orchestrator/shared/runtime_policy";
import { resolveSessionArtifactPaths } from "../../../../tools/orchestrator/shared/session_artifacts";

type Command = "select-phase" | "run";
type Phase = "intake" | "execute" | "resume" | "close";

type Cli = {
  command: Command;
  repository: string;
  issue: string;
  parentIssue: string;
  stateBackend: string;
  stateDir: string;
  sessionId: string;
  intakeInput: string;
  taskSource: string;
  skillsConfig: string;
  profile: string;
  allowDirtyBase: boolean;
  runIssue: string;
  runId: string;
  baseBranch: string;
};

type JsonObject = Record<string, unknown>;

type SelectionResult = {
  phase: Phase;
  source: "session" | "github";
  reason: string;
  repository: string;
  parent_issue_number: number;
  task_issue_number: number;
  session_id: string;
  state_dir: string;
  missing_inputs: string[];
  task_issue_count: number;
  open_task_issue_count: number;
  done_task_issue_count: number;
};

type PhaseInvocation = {
  scriptPath: string;
  args: string[];
};

type SessionStateSelectionInput = {
  stateDir: string;
  repository: string;
  parentIssueNumber: number;
  sessionId: string;
};

type TaskIssueSelectionInput = {
  repository: string;
  parentIssueNumber: number;
  taskIssueNumber: number;
  sessionId: string;
  stateDir: string;
  intakeInput: string;
  taskIssues: TaskIssue[];
};

type RequestedIssueScope = {
  parentIssueNumber: number;
  taskIssueNumber: number;
};

const TERMINAL_NODE_STATUSES = new Set(["done", "failed", "blocked", "merged"]);

function usage(): string {
  return [
    "Usage:",
    "  bun supervisor_runtime.ts select-phase --repository <owner/repo> [--issue <number|url>] [--parent-issue <number|url>] [--state-backend <github|local>] [--state-dir <path>] [--session-id <value>] [--intake-input <path>]",
    "  bun supervisor_runtime.ts run --repository <owner/repo> [--issue <number|url>] [--parent-issue <number|url>] [--state-backend <github|local>] [--state-dir <path>] [--session-id <value>] [--intake-input <path>] [--task-source <issues.json>] [--skills-config <path>] [--profile <name>] [--allow-dirty-base] [--run-issue <number>] [--run-id <value>] [--base-branch <name>]",
    "",
    "Notes:",
    "  - phase selection uses session artifacts first, then GitHub task issue state under the requested issue selector.",
    "  - --issue is the canonical selector: task issue first, parent issue only when grouped work is intended.",
    "  - resume reuses execute runtime with an existing session state directory.",
    "  - if GitHub task state implies close but session artifacts are missing, run fails closed.",
    "  - intake routing requires --intake-input and is available only for parent-scoped grouped work.",
  ].join("\n");
}

function fail(message: string): never {
  throw new Error(message);
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

function invokeBun(scriptPath: string, args: string[], cwd: string): void {
  const result = spawnSync("bun", [scriptPath, ...args], {
    cwd,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) {
    fail(`failed to spawn bun for ${path.basename(scriptPath)}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`${path.basename(scriptPath)} ${args.join(" ")} failed: exit=${result.status ?? 1}`);
  }
}

function resolveRepoRoot(): string {
  const repoRoot = run("git", ["rev-parse", "--show-toplevel"], process.cwd());
  if (!repoRoot) fail("failed to resolve repository root");
  return repoRoot;
}

function parseCli(argv: string[]): Cli {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }

  const commandRaw = String(argv[0] || "").trim();
  if (commandRaw !== "select-phase" && commandRaw !== "run") {
    fail(`unknown command: ${commandRaw}`);
  }

  const allowedFlags = new Set([
    "repository",
    "issue",
    "parent-issue",
    "state-backend",
    "state-dir",
    "session-id",
    "intake-input",
    "task-source",
    "skills-config",
    "profile",
    "allow-dirty-base",
    "run-issue",
    "run-id",
    "base-branch",
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
    command: commandRaw,
    repository: String(flags.get("repository") || "").trim(),
    issue: String(flags.get("issue") || "").trim(),
    parentIssue: String(flags.get("parent-issue") || "").trim(),
    stateBackend: String(flags.get("state-backend") || "").trim(),
    stateDir: String(flags.get("state-dir") || "").trim(),
    sessionId: String(flags.get("session-id") || "").trim(),
    intakeInput: String(flags.get("intake-input") || "").trim(),
    taskSource: String(flags.get("task-source") || "").trim(),
    skillsConfig: String(flags.get("skills-config") || "").trim(),
    profile: String(flags.get("profile") || "").trim(),
    allowDirtyBase,
    runIssue: String(flags.get("run-issue") || "").trim(),
    runId: String(flags.get("run-id") || "").trim(),
    baseBranch: String(flags.get("base-branch") || "").trim(),
  };
}

export function buildSessionId(now: Date = new Date()): string {
  return buildSharedSessionId(now);
}

export function resolveSessionId(value: string, fallback: string = buildSessionId()): string {
  return resolveSharedSessionId(value, {
    envValue: String(process.env.ORCHESTRATE_SESSION_ID || "").trim(),
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
  return resolveSharedRuntimeStateDir(repoRoot, inputStateDir, sessionId, {
    create: false,
  });
}

export function parseIssueNumber(value: string, flagName = "--issue"): number {
  const text = value.trim();
  if (!text) return 0;
  const numberMatch = text.match(/^#?(\d+)$/);
  if (numberMatch) return Number(numberMatch[1] || "0");
  const urlMatch = text.match(/\/issues\/(\d+)(?:\/)?$/);
  if (urlMatch) return Number(urlMatch[1] || "0");
  fail(`${flagName} must be an issue number or issue URL: ${value}`);
}

export function parseParentIssueNumber(value: string): number {
  return parseIssueNumber(value, "--parent-issue");
}

export function resolveRequestedIssueScope(
  taskIssues: TaskIssue[],
  issueNumber: number
): RequestedIssueScope {
  if (issueNumber <= 0) {
    return { parentIssueNumber: 0, taskIssueNumber: 0 };
  }
  const matchingTaskIssue = taskIssues.find((entry) => entry.number === issueNumber);
  if (matchingTaskIssue) {
    return { parentIssueNumber: 0, taskIssueNumber: issueNumber };
  }
  return { parentIssueNumber: issueNumber, taskIssueNumber: 0 };
}

function detectAnySessionArtifacts(stateDir: string): boolean {
  const paths = resolveSessionArtifactPaths(stateDir);
  const fileCandidates = [
    paths.manifestJson,
    paths.executionPlanJson,
    paths.gateResultsJson,
    paths.githubRunContextJson,
    paths.closeoutSummaryJson,
    paths.cleanupPlanJson,
  ];
  const directoryCandidates = [
    paths.inputsDir,
    paths.tasksDir,
    paths.statusDir,
    paths.reviewDir,
    paths.conflictDir,
    paths.childExecDir,
  ];

  return (
    fileCandidates.some((candidate) => existsSync(candidate)) ||
    directoryCandidates.some((candidate) => existsSync(candidate))
  );
}

export function selectPhaseFromSessionState(
  input: SessionStateSelectionInput
): SelectionResult | null {
  const paths = resolveSessionArtifactPaths(input.stateDir);
  if (!existsSync(paths.stateJson)) {
    if (detectAnySessionArtifacts(input.stateDir)) {
      fail(`session artifacts exist but state.json is missing: ${input.stateDir}`);
    }
    return null;
  }

  const raw = JSON.parse(readFileSync(paths.stateJson, "utf8")) as unknown;
  if (!isObject(raw) || !isObject(raw.nodes)) {
    fail(`invalid session state payload: ${paths.stateJson}`);
  }

  const nodeStatuses = Object.values(raw.nodes)
    .map((entry) => {
      if (!isObject(entry)) return "";
      return String(entry.status || "")
        .trim()
        .toLowerCase();
    })
    .filter(Boolean);

  if (nodeStatuses.length === 0) {
    fail(`session state contains no nodes: ${paths.stateJson}`);
  }

  const activeStatuses = nodeStatuses.filter((status) => !TERMINAL_NODE_STATUSES.has(status));
  if (activeStatuses.length > 0) {
    return {
      phase: "resume",
      source: "session",
      reason: `session has ${activeStatuses.length} non-terminal node(s)`,
      repository: input.repository,
      parent_issue_number: input.parentIssueNumber,
      task_issue_number: 0,
      session_id: input.sessionId,
      state_dir: input.stateDir,
      missing_inputs: [],
      task_issue_count: 0,
      open_task_issue_count: 0,
      done_task_issue_count: 0,
    };
  }

  return {
    phase: "close",
    source: "session",
    reason: `session has ${nodeStatuses.length} terminal node(s)`,
    repository: input.repository,
    parent_issue_number: input.parentIssueNumber,
    task_issue_number: 0,
    session_id: input.sessionId,
    state_dir: input.stateDir,
    missing_inputs: [],
    task_issue_count: 0,
    open_task_issue_count: 0,
    done_task_issue_count: nodeStatuses.length,
  };
}

export function selectPhaseFromTaskIssues(input: TaskIssueSelectionInput): SelectionResult {
  if (input.taskIssueNumber > 0) {
    const issue = input.taskIssues.find((entry) => entry.number === input.taskIssueNumber);
    if (!issue) {
      fail(`task issue #${input.taskIssueNumber} was not found in the canonical task issue set`);
    }
    const isOpen = issue.state === "open";
    return {
      phase: isOpen ? "execute" : "close",
      source: "github",
      reason: isOpen
        ? `task issue #${input.taskIssueNumber} is open`
        : `task issue #${input.taskIssueNumber} is already done`,
      repository: input.repository,
      parent_issue_number: Number(issue.graph.parent || 0),
      task_issue_number: input.taskIssueNumber,
      session_id: input.sessionId,
      state_dir: input.stateDir,
      missing_inputs: isOpen ? [] : ["session-state"],
      task_issue_count: 1,
      open_task_issue_count: isOpen ? 1 : 0,
      done_task_issue_count: isOpen ? 0 : 1,
    };
  }

  const parentTasks = input.taskIssues.filter(
    (issue) => issue.graph.parent === input.parentIssueNumber
  );
  const openTaskCount = parentTasks.filter((issue) => issue.state === "open").length;
  const doneTaskCount = parentTasks.length - openTaskCount;

  if (parentTasks.length === 0) {
    return {
      phase: "intake",
      source: "github",
      reason: `parent issue #${input.parentIssueNumber} has no linked task issues`,
      repository: input.repository,
      parent_issue_number: input.parentIssueNumber,
      task_issue_number: 0,
      session_id: input.sessionId,
      state_dir: input.stateDir,
      missing_inputs: input.intakeInput ? [] : ["intake-input"],
      task_issue_count: 0,
      open_task_issue_count: 0,
      done_task_issue_count: 0,
    };
  }

  if (openTaskCount > 0) {
    return {
      phase: "execute",
      source: "github",
      reason: `parent issue #${input.parentIssueNumber} has ${openTaskCount} open task issue(s)`,
      repository: input.repository,
      parent_issue_number: input.parentIssueNumber,
      task_issue_number: 0,
      session_id: input.sessionId,
      state_dir: input.stateDir,
      missing_inputs: [],
      task_issue_count: parentTasks.length,
      open_task_issue_count: openTaskCount,
      done_task_issue_count: doneTaskCount,
    };
  }

  return {
    phase: "close",
    source: "github",
    reason: `parent issue #${input.parentIssueNumber} task issues are already done`,
    repository: input.repository,
    parent_issue_number: input.parentIssueNumber,
    task_issue_number: 0,
    session_id: input.sessionId,
    state_dir: input.stateDir,
    missing_inputs: ["session-state"],
    task_issue_count: parentTasks.length,
    open_task_issue_count: 0,
    done_task_issue_count: doneTaskCount,
  };
}

async function selectPhase(repoRoot: string, cli: Cli): Promise<SelectionResult> {
  const repository = cli.repository.trim();
  if (!repository) fail("--repository is required");

  const sessionId = resolveSessionId(cli.sessionId);
  const stateDir = resolveRuntimeStateDir(repoRoot, cli.stateDir, sessionId);
  const issueNumber = cli.issue.trim() ? parseIssueNumber(cli.issue, "--issue") : 0;
  const parentIssueNumber = cli.parentIssue.trim() ? parseParentIssueNumber(cli.parentIssue) : 0;
  if (issueNumber > 0 && parentIssueNumber > 0) {
    fail("--issue and --parent-issue are mutually exclusive");
  }
  const sessionSelection = selectPhaseFromSessionState({
    stateDir,
    repository,
    parentIssueNumber,
    sessionId,
  });
  if (sessionSelection) return sessionSelection;

  if (!issueNumber && !parentIssueNumber) {
    fail("--issue or --parent-issue is required when no session state exists");
  }

  const issueGraph = await loadTaskIssues({ repository });
  const resolvedScope =
    issueNumber > 0
      ? resolveRequestedIssueScope(issueGraph.issues, issueNumber)
      : { parentIssueNumber, taskIssueNumber: 0 };
  return selectPhaseFromTaskIssues({
    repository,
    parentIssueNumber: resolvedScope.parentIssueNumber,
    taskIssueNumber: resolvedScope.taskIssueNumber,
    sessionId,
    stateDir,
    intakeInput: cli.intakeInput,
    taskIssues: issueGraph.issues,
  });
}

function pushValueFlag(args: string[], flag: string, value: string): void {
  if (!value.trim()) return;
  args.push(flag, value.trim());
}

export function buildPhaseInvocations(
  skillRoot: string,
  cli: Cli,
  selection: SelectionResult
): PhaseInvocation[] {
  const supervisorRoot = path.resolve(skillRoot, "..");
  const planRuntime = path.join(supervisorRoot, "orchestrate-plan", "scripts", "plan_runtime.ts");
  const executeRuntime = path.join(
    supervisorRoot,
    "orchestrate-execute",
    "scripts",
    "execute_runtime.ts"
  );
  const closeRuntime = path.join(
    supervisorRoot,
    "orchestrate-close",
    "scripts",
    "close_runtime.ts"
  );

  switch (selection.phase) {
    case "intake": {
      if (!cli.intakeInput.trim()) {
        fail("selected phase intake requires --intake-input");
      }
      return [
        {
          scriptPath: planRuntime,
          args: [
            "intake-upsert",
            "--input",
            path.resolve(cli.intakeInput),
            "--repository",
            selection.repository,
            "--parent-issue",
            String(selection.parent_issue_number),
          ],
        },
        {
          scriptPath: planRuntime,
          args: ["intake-validate", "--repository", selection.repository],
        },
      ];
    }
    case "execute":
    case "resume": {
      const args = ["run", "--state-backend", resolveStateBackend(cli.stateBackend)];
      pushValueFlag(args, "--profile", cli.profile);
      pushValueFlag(args, "--state-dir", selection.state_dir);
      pushValueFlag(args, "--run-issue", cli.runIssue);
      pushValueFlag(args, "--task-source", cli.taskSource);
      pushValueFlag(args, "--skills-config", cli.skillsConfig);
      if (cli.allowDirtyBase) args.push("--allow-dirty-base");
      pushValueFlag(args, "--session-id", selection.session_id);
      return [{ scriptPath: executeRuntime, args }];
    }
    case "close": {
      const args = [
        "run",
        "--repository",
        selection.repository,
        "--state-backend",
        resolveStateBackend(cli.stateBackend),
      ];
      pushValueFlag(args, "--state-dir", selection.state_dir);
      pushValueFlag(args, "--session-id", selection.session_id);
      pushValueFlag(args, "--run-issue", cli.runIssue);
      pushValueFlag(args, "--run-id", cli.runId);
      pushValueFlag(args, "--base-branch", cli.baseBranch);
      return [{ scriptPath: closeRuntime, args }];
    }
  }
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  const repoRoot = resolveRepoRoot();
  const skillRoot = path.resolve(import.meta.dir, "..");
  const selection = await selectPhase(repoRoot, cli);

  process.stdout.write(`${JSON.stringify(selection, null, 2)}\n`);

  if (cli.command === "select-phase") {
    return;
  }

  if (selection.missing_inputs.length > 0) {
    fail(`selected phase ${selection.phase} requires ${selection.missing_inputs.join(", ")}`);
  }

  const invocations = buildPhaseInvocations(skillRoot, cli, selection);
  for (const invocation of invocations) {
    if (!existsSync(invocation.scriptPath)) {
      fail(`phase runtime not found: ${invocation.scriptPath}`);
    }
    invokeBun(invocation.scriptPath, invocation.args, repoRoot);
  }
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(`supervisor_runtime failed: ${(error as Error).message}`);
    process.exit(1);
  });
}
