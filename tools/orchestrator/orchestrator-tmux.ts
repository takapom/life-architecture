#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  resolveRuntimeStateDir as resolveSharedRuntimeStateDir,
  resolveSessionId as resolveSharedSessionId,
} from "./shared/runtime_policy";

type Command = "prepare" | "attach" | "capture" | "stop";

type Cli = {
  command: Command;
  sessionId: string;
  stateDir: string;
  tmuxSession: string;
};

type JsonObject = Record<string, unknown>;

type ViewportNode = {
  node_id: string;
  status: string;
  branch: string;
  worktree: string;
  claim_owner: string;
};

type ViewportPane = {
  title: string;
  cwd: string;
  lines: string[];
};

type ViewportWindow = {
  name: string;
  panes: ViewportPane[];
};

type ViewportPlan = {
  session_id: string;
  tmux_session: string;
  state_dir: string;
  windows: ViewportWindow[];
};

type PrepareOperation = {
  args: string[];
};

type CapturedPane = {
  target: string;
  window: string;
  pane_index: number;
  pane_id: string;
  title: string;
  cwd: string;
  content: string;
};

const ACTIVE_VIEWPORT_STATUSES = new Set(["queued", "running", "ready_for_review", "merging"]);
const DEFAULT_SHELL = Bun.env.SHELL || "/bin/zsh";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function requirePane(windowName: string, pane: ViewportPane | undefined, paneIndex: number) {
  assert(pane, `missing pane ${paneIndex} in tmux window ${windowName}`);
  return pane;
}

function usage(): string {
  return [
    "Usage:",
    "  bun run orchestrator:status -- prepare [--session-id <value>] [--state-dir <path>] [--tmux-session <name>]",
    "  bun run orchestrator:attach -- attach [--session-id <value>] [--state-dir <path>] [--tmux-session <name>]",
    "  bun run orchestrator:resume -- capture [--session-id <value>] [--state-dir <path>] [--tmux-session <name>]",
    "  bun run orchestrator:close -- stop [--session-id <value>] [--state-dir <path>] [--tmux-session <name>]",
    "",
    "Notes:",
    "  - tmux is a derived viewport only. Runtime state remains in session artifacts.",
    "  - one tmux session maps to one orchestration run/session-id.",
    "  - prepare creates or refreshes the tmux layout from state.json.",
    "  - attach creates the tmux session when missing, then attaches to it.",
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

  const command = String(argv[0] || "").trim();
  if (
    command !== "prepare" &&
    command !== "attach" &&
    command !== "capture" &&
    command !== "stop"
  ) {
    fail(`unknown command: ${command}`);
  }

  const flags = new Map<string, string>();
  const allowedFlags = new Set(["session-id", "state-dir", "tmux-session"]);

  for (let i = 1; i < argv.length; i += 1) {
    const token = String(argv[i] || "");
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
    sessionId: String(flags.get("session-id") || "").trim(),
    stateDir: String(flags.get("state-dir") || "").trim(),
    tmuxSession: String(flags.get("tmux-session") || "").trim(),
  };
}

export function resolveSessionId(value: string, stateDir: string, fallback = ""): string {
  const explicit = value.trim();
  const fromStateDir = stateDir ? path.basename(path.resolve(stateDir)) : "";
  return resolveSharedSessionId(explicit || fromStateDir, {
    envValue: String(Bun.env.ORCHESTRATE_SESSION_ID || "").trim(),
    fallback,
    normalizeCase: true,
    requiredMessage: "--session-id or --state-dir is required",
  });
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

export function normalizeTmuxSessionName(sessionId: string, override = ""): string {
  const raw = (override.trim() || `orch-${sessionId}`).toLowerCase();
  const normalized = raw.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!normalized) {
    fail("failed to resolve tmux session name");
  }
  return normalized.slice(0, 80);
}

function readStateJson(stateDir: string): JsonObject {
  const statePath = path.join(stateDir, "state.json");
  if (!existsSync(statePath)) {
    fail(`required file not found: ${statePath}`);
  }
  const raw = JSON.parse(readFileSync(statePath, "utf8")) as unknown;
  if (!isObject(raw) || !isObject(raw.nodes)) {
    fail(`invalid session state payload: ${statePath}`);
  }
  return raw;
}

export function readViewportNodes(stateDir: string): ViewportNode[] {
  const state = readStateJson(stateDir);
  const nodes = Object.entries(state.nodes || {})
    .map(([nodeId, value]) => {
      if (!isObject(value)) return null;
      const status = String(value.status || "")
        .trim()
        .toLowerCase();
      if (!ACTIVE_VIEWPORT_STATUSES.has(status)) return null;
      return {
        node_id: nodeId,
        status,
        branch: String(value.branch || "").trim(),
        worktree: String(value.worktree || "").trim(),
        claim_owner: String(value.claim_owner || value.claimed_by || "").trim(),
      } satisfies ViewportNode;
    })
    .filter((entry): entry is ViewportNode => Boolean(entry))
    .sort((a, b) => a.node_id.localeCompare(b.node_id));

  return nodes;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildPaneCommand(pane: ViewportPane): string {
  const lines = pane.lines.map((line) => `printf '%s\\n' ${shellQuote(line)}`).join(" && ");
  return `cd ${shellQuote(pane.cwd)} && clear && ${lines} && exec ${shellQuote(DEFAULT_SHELL)} -l`;
}

export function buildViewportPlan(options: {
  repoRoot: string;
  sessionId: string;
  stateDir: string;
  tmuxSession: string;
  nodes: ViewportNode[];
}): ViewportPlan {
  const overviewPane: ViewportPane = {
    title: "overview",
    cwd: options.repoRoot,
    lines: [
      `session=${options.sessionId}`,
      `state_dir=${options.stateDir}`,
      "tmux is a derived viewport only; runtime state lives in session artifacts.",
    ],
  };

  const nodePanes =
    options.nodes.length > 0
      ? options.nodes.map((node) => ({
          title: `${node.node_id} ${node.status}`,
          cwd: node.worktree || options.stateDir,
          lines: [
            `node=${node.node_id}`,
            `status=${node.status}`,
            `branch=${node.branch || "(unknown)"}`,
            `worktree=${node.worktree || "(missing)"}`,
            `claim_owner=${node.claim_owner || "(none)"}`,
          ],
        }))
      : [
          {
            title: "no-active-nodes",
            cwd: options.stateDir,
            lines: [
              `session=${options.sessionId}`,
              "No active nodes in state.json.",
              "Use close/runtime artifacts for post-run investigation.",
            ],
          },
        ];

  return {
    session_id: options.sessionId,
    tmux_session: options.tmuxSession,
    state_dir: options.stateDir,
    windows: [
      { name: "overview", panes: [overviewPane] },
      { name: "workers", panes: nodePanes },
    ],
  };
}

export function buildPrepareOperations(plan: ViewportPlan): PrepareOperation[] {
  const operations: PrepareOperation[] = [];
  const [overview, workers] = plan.windows;
  assert(overview, "viewport plan must define an overview window");
  assert(workers, "viewport plan must define a workers window");
  const overviewPane = requirePane(overview.name, overview.panes[0], 0);
  const workerRootPane = requirePane(workers.name, workers.panes[0], 0);

  operations.push({
    args: [
      "new-session",
      "-d",
      "-s",
      plan.tmux_session,
      "-n",
      overview.name,
      buildPaneCommand(overviewPane),
    ],
  });
  operations.push({
    args: [
      "select-pane",
      "-t",
      `${plan.tmux_session}:${overview.name}.0`,
      "-T",
      overviewPane.title,
    ],
  });

  operations.push({
    args: [
      "new-window",
      "-t",
      plan.tmux_session,
      "-n",
      workers.name,
      buildPaneCommand(workerRootPane),
    ],
  });
  operations.push({
    args: [
      "select-pane",
      "-t",
      `${plan.tmux_session}:${workers.name}.0`,
      "-T",
      workerRootPane.title,
    ],
  });

  for (let index = 1; index < workers.panes.length; index += 1) {
    const pane = requirePane(workers.name, workers.panes[index], index);
    operations.push({
      args: [
        "split-window",
        "-t",
        `${plan.tmux_session}:${workers.name}`,
        "-v",
        buildPaneCommand(pane),
      ],
    });
    operations.push({
      args: [
        "select-pane",
        "-t",
        `${plan.tmux_session}:${workers.name}.${index}`,
        "-T",
        pane.title,
      ],
    });
  }

  operations.push({
    args: ["select-layout", "-t", `${plan.tmux_session}:${workers.name}`, "tiled"],
  });
  return operations;
}

function ensureTmuxAvailable(repoRoot: string): void {
  run("tmux", ["-V"], repoRoot);
}

function runTmux(repoRoot: string, args: string[], stdio: "pipe" | "inherit" = "pipe"): string {
  const result = spawnSync("tmux", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: stdio === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const detail = `${result.stderr || ""}\n${result.stdout || ""}`.trim();
    fail(`tmux ${args.join(" ")} failed: ${detail || `exit=${result.status}`}`);
  }
  return String(result.stdout || "").trim();
}

function hasTmuxSession(repoRoot: string, sessionName: string): boolean {
  const result = spawnSync("tmux", ["has-session", "-t", sessionName], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.status === 0;
}

function ensureTmuxSession(repoRoot: string, plan: ViewportPlan): void {
  ensureTmuxAvailable(repoRoot);
  if (hasTmuxSession(repoRoot, plan.tmux_session)) {
    runTmux(repoRoot, ["kill-session", "-t", plan.tmux_session]);
  }
  for (const operation of buildPrepareOperations(plan)) {
    runTmux(repoRoot, operation.args);
  }
}

type PaneListing = {
  target: string;
  window: string;
  pane_index: number;
  pane_id: string;
  title: string;
  cwd: string;
};

export function parsePaneListOutput(output: string): PaneListing[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [target, window, paneIndex, paneId, title, cwd] = line.split("\t");
      return {
        target,
        window,
        pane_index: Number(paneIndex || "0"),
        pane_id: paneId,
        title,
        cwd,
      };
    })
    .filter((entry) => entry.target && entry.pane_id);
}

function captureSession(repoRoot: string, sessionName: string): CapturedPane[] {
  ensureTmuxAvailable(repoRoot);
  if (!hasTmuxSession(repoRoot, sessionName)) {
    fail(`tmux session not found: ${sessionName}`);
  }
  const paneOutput = runTmux(repoRoot, [
    "list-panes",
    "-t",
    sessionName,
    "-F",
    "#{session_name}:#{window_name}.#{pane_index}\t#{window_name}\t#{pane_index}\t#{pane_id}\t#{pane_title}\t#{pane_current_path}",
  ]);
  return parsePaneListOutput(paneOutput).map((pane) => ({
    ...pane,
    content: runTmux(repoRoot, ["capture-pane", "-p", "-t", pane.pane_id]),
  }));
}

function stopSession(repoRoot: string, sessionName: string): { stopped: boolean } {
  ensureTmuxAvailable(repoRoot);
  if (!hasTmuxSession(repoRoot, sessionName)) {
    return { stopped: false };
  }
  runTmux(repoRoot, ["kill-session", "-t", sessionName]);
  return { stopped: true };
}

function resolveSessionIdentity(cli: Cli): {
  sessionId: string;
  tmuxSession: string;
} {
  const sessionId = resolveSessionId(cli.sessionId, cli.stateDir);
  return {
    sessionId,
    tmuxSession: normalizeTmuxSessionName(sessionId, cli.tmuxSession),
  };
}

function resolveViewportContext(
  repoRoot: string,
  cli: Cli
): {
  sessionId: string;
  stateDir: string;
  tmuxSession: string;
  nodes: ViewportNode[];
  plan: ViewportPlan;
} {
  const identity = resolveSessionIdentity(cli);
  const sessionId = identity.sessionId;
  const stateDir = resolveRuntimeStateDir(repoRoot, cli.stateDir, sessionId);
  const tmuxSession = identity.tmuxSession;
  const nodes = readViewportNodes(stateDir);
  const plan = buildViewportPlan({
    repoRoot,
    sessionId,
    stateDir,
    tmuxSession,
    nodes,
  });
  return {
    sessionId,
    stateDir,
    tmuxSession,
    nodes,
    plan,
  };
}

function main(): void {
  const cli = parseCli(process.argv.slice(2));
  const repoRoot = resolveRepoRoot();
  const identity = resolveSessionIdentity(cli);

  switch (cli.command) {
    case "prepare": {
      const context = resolveViewportContext(repoRoot, cli);
      ensureTmuxSession(repoRoot, context.plan);
      process.stdout.write(`${JSON.stringify(context.plan, null, 2)}\n`);
      return;
    }
    case "attach":
      if (!hasTmuxSession(repoRoot, identity.tmuxSession)) {
        const context = resolveViewportContext(repoRoot, cli);
        ensureTmuxSession(repoRoot, context.plan);
      }
      runTmux(repoRoot, ["attach-session", "-t", identity.tmuxSession], "inherit");
      return;
    case "capture":
      process.stdout.write(
        `${JSON.stringify(
          {
            session_id: identity.sessionId,
            tmux_session: identity.tmuxSession,
            panes: captureSession(repoRoot, identity.tmuxSession),
          },
          null,
          2
        )}\n`
      );
      return;
    case "stop":
      process.stdout.write(
        `${JSON.stringify(
          {
            session_id: identity.sessionId,
            tmux_session: identity.tmuxSession,
            ...stopSession(repoRoot, identity.tmuxSession),
          },
          null,
          2
        )}\n`
      );
  }
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`orchestrator-tmux failed: ${(error as Error).message}\n`);
    process.exit(1);
  }
}
