#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  normalizeTaskBoardStatus,
  TASK_CONTROL_PLANE_FIELD_ALIASES,
} from "../../../../tools/orchestrator/task-lifecycle/task-control-plane";
import {
  fetchProjectFieldMap,
  pickProjectField,
} from "../../../../tools/adapters/github-project-fields";
import { readGithubRunContextFile } from "../../../../tools/orchestrator/shared/github_run_context";
import {
  enforceStateDirPolicy,
  resolveSessionId as resolveSharedSessionId,
  resolveStateBackend,
  resolveStateDirForSession,
} from "../../../../tools/orchestrator/shared/runtime_policy";
import {
  resolveSessionArtifactPaths,
  writeSessionArtifactManifest,
} from "../../../../tools/orchestrator/shared/session_artifacts";

export { resolveStateBackend };

type JsonObject = Record<string, unknown>;

type Command = "verify" | "run" | "cleanup-plan" | "cleanup-apply";

type Cli = {
  command: Command;
  stateDir: string;
  sessionId: string;
  stateBackend: string;
  baseBranch: string;
  repository: string;
  runIssue: string;
  runId: string;
  followupOutput: string;
  closeoutOutput: string;
  cleanupPlanOutput: string;
  cleanupPlanInput: string;
  dryRun: boolean;
  skipTaskStatusSync: boolean;
  skipParentIssueSync: boolean;
};

type NodeState = {
  status: string;
  branch: string;
  worktree: string;
  attempts: number;
  last_update: string;
};

type StatePayload = {
  updated_at: string;
  nodes: Record<string, NodeState>;
};

type GateNode = {
  node_id: string;
  status: string;
  branch: string;
  summary: string;
  failure_reason: string;
  pr_url: string;
  artifacts: Record<string, string>;
};

type GateResultsPayload = {
  generated_at: string;
  state_updated_at: string;
  nodes: GateNode[];
};

type ResidueItem = {
  node_id: string;
  status: string;
  branch: string;
  summary: string;
  failure_reason: string;
  pr_url: string;
  review_decision: string;
  review_summary: string;
  review_findings: ReviewFinding[];
  review_escalation: {
    level: string;
    reason: string;
  };
};

type ReviewFinding = {
  severity: string;
  category: string;
  summary: string;
  path?: string;
  line?: number;
};

type ReviewArtifact = {
  decision: string;
  summary: string;
  findings: ReviewFinding[];
  escalation: {
    level: string;
    reason: string;
  };
};

type CleanupResult = {
  task_id: string;
  pr: string;
  ok: boolean;
  detail: string;
};

type CleanupPlanTarget = {
  task_id: string;
  pr: string;
};

type CleanupPlan = {
  cleanup_plan_version: 1;
  generated_at: string;
  plan_id: string;
  state_backend: "github" | "local";
  repository: string;
  run_issue_number: number;
  run_id: string;
  target_count: number;
  targets: CleanupPlanTarget[];
};

type WorktreeClassification = {
  group: string;
  branch: string;
  ahead: number;
  behind: number;
  worktree: string;
  merge_reason: string;
};

type GithubRunNode = {
  task_id: string;
  status: string;
  run_id: string;
  pr_url: string;
  failure_reason: string;
  updated_at: string;
};

type ParentIssueSyncScope = {
  executionPlanPath: string;
  parentIssueNumbers: number[];
};

const TERMINAL_STATUSES = new Set(["done", "failed", "blocked", "merged"]);

const CLOSE_RUNTIME_PROJECT_FIELD_NAMES = [
  TASK_CONTROL_PLANE_FIELD_ALIASES.task_id[0],
  TASK_CONTROL_PLANE_FIELD_ALIASES.status[0],
  TASK_CONTROL_PLANE_FIELD_ALIASES.run_id[0],
  TASK_CONTROL_PLANE_FIELD_ALIASES.pr_url[0],
  TASK_CONTROL_PLANE_FIELD_ALIASES.failure_reason[0],
  TASK_CONTROL_PLANE_FIELD_ALIASES.updated_at[0],
] as const;

function usage(): string {
  return [
    "Usage:",
    "  bun close_runtime.ts verify [--state-backend <github|local>] [--state-dir <path>] [--session-id <value>] --repository <owner/repo> [--base-branch <name>]",
    "  bun close_runtime.ts run [--state-backend <github|local>] [--state-dir <path>] [--session-id <value>] --repository <owner/repo> [--run-issue <number>] [--run-id <id>] [--base-branch <name>] [--followup-output <path>] [--closeout-output <path>] [--cleanup-plan-output <path>] [--skip-task-status-sync] [--skip-parent-issue-sync]",
    "  bun close_runtime.ts cleanup-plan [--state-backend <github|local>] [--state-dir <path>] [--session-id <value>] --repository <owner/repo> [--run-issue <number>] [--run-id <id>] [--cleanup-plan-output <path>]",
    "  bun close_runtime.ts cleanup-apply [--state-backend <github|local>] [--state-dir <path>] [--session-id <value>] [--repository <owner/repo>] [--cleanup-plan-input <path>] [--dry-run]",
    "",
    "Notes:",
    "  - state dir defaults to <repo_parent>/wt/.omta/state/sessions/<session-id>.",
    "  - when --state-dir is omitted, --session-id or ORCHESTRATE_SESSION_ID is required (except cleanup-apply with --cleanup-plan-input).",
    "  - state-backend defaults to github.",
    "  - local backend reads runtime artifacts (state.json, gate-results.json, status/*.json).",
    "  - github backend resolves run context from github-run-context.json (or explicit CLI overrides) and reconstructs task state from Project-v2 fields using that run_id.",
    "  - run command reconciles bounded task item statuses so closed tasks are Done and open tasks are never left at Done/invalid unless --skip-task-status-sync is set.",
    "  - run command bounds parent issue sync to state-dir/inputs/execution-plan.json, skips standalone runs with no grouped parent scope, and fails closed on missing execution-plan artifacts or incomplete parent metadata.",
    "  - follow-up drafting targets all residue nodes.",
    "  - cleanup apply is explicit and separated: use cleanup-apply command.",
  ].join("\n");
}

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

function runResult(
  command: string,
  args: string[],
  cwd: string
): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: Number(result.status ?? 1),
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
  };
}

function nowIsoUtc(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseJson(text: string, source: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    fail(`invalid JSON (${source}): ${(error as Error).message}`);
  }
}

function readJsonFile(filePath: string): unknown {
  if (!existsSync(filePath)) {
    fail(`required file not found: ${filePath}`);
  }
  return parseJson(readFileSync(filePath, "utf8"), filePath);
}

function parseRepositorySlug(repository: string): { owner: string; repo: string } {
  const value = repository.trim();
  const parts = value.split("/").filter(Boolean);
  if (parts.length !== 2) {
    fail(`invalid repository slug: ${repository}`);
  }
  return { owner: parts[0], repo: parts[1] };
}

function resolveProjectNumberHint(): number {
  for (const envName of [
    "ISSUE_GRAPH_PROJECT_NUMBER",
    "ORCHESTRATE_PROJECT_NUMBER",
    "ISSUE_DAG_PROJECT_NUMBER",
  ] as const) {
    const raw = String(process.env[envName] || "").trim();
    if (!raw) continue;
    const num = Number(raw);
    if (Number.isInteger(num) && num > 0) return num;
  }
  return 0;
}

export function normalizeKanbanStatus(value: string): string {
  return normalizeTaskBoardStatus(value);
}

export function mapKanbanStatusToCloseStatus(value: string): string {
  const status = normalizeKanbanStatus(value);
  if (!status) return "";
  if (status === "backlog" || status === "ready") return "pending";
  if (status === "in progress") return "running";
  if (status === "in review") return "ready_for_review";
  if (status === "done") return "done";
  return "";
}

function normalizeReviewDecision(value: string): string {
  const decision = value.trim().toLowerCase();
  if (decision === "approve" || decision === "rework" || decision === "reject") {
    return decision;
  }
  return "";
}

function normalizeReviewArtifact(value: unknown): ReviewArtifact | null {
  if (!isObject(value)) return null;
  const findingsRaw = Array.isArray(value.findings) ? value.findings : [];
  const findings: ReviewFinding[] = findingsRaw
    .filter((entry) => isObject(entry))
    .map((entry) => {
      const finding: ReviewFinding = {
        severity: String(entry.severity || "medium").trim() || "medium",
        category: String(entry.category || "review").trim() || "review",
        summary: String(entry.summary || "").trim(),
      };
      const findingPath = String(entry.path || "").trim();
      if (findingPath) finding.path = findingPath;
      const line = Number(entry.line || 0);
      if (Number.isInteger(line) && line > 0) finding.line = line;
      return finding;
    })
    .filter((entry) => entry.summary.length > 0);
  const escalation = isObject(value.escalation) ? value.escalation : {};
  return {
    decision: normalizeReviewDecision(String(value.decision || "")),
    summary: String(value.summary || value.notes || "").trim(),
    findings,
    escalation: {
      level: String(escalation.level || "none").trim() || "none",
      reason: String(escalation.reason || "").trim(),
    },
  };
}

function mapGithubRunNodeToCloseStatus(item: GithubRunNode): string {
  const mapped = mapKanbanStatusToCloseStatus(item.status) || "pending";
  if (mapped !== "running") return mapped;
  const reason = item.failure_reason.trim().toLowerCase();
  if (!reason || reason === "none") return mapped;
  return "blocked";
}

function extractTaskIdFromTitle(title: string): string {
  const matched = title.match(/[A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*-\d{3,}[a-z]?/);
  return matched ? matched[0] : "";
}

function loadGithubRunNodesFromProject(options: {
  repoRoot: string;
  repository: string;
  runId: string;
  projectNumber: number;
}): GithubRunNode[] {
  const { owner } = parseRepositorySlug(options.repository);

  if (options.projectNumber <= 0) {
    fail(
      [
        "github close requires explicit project selection",
        "set ISSUE_GRAPH_PROJECT_NUMBER, ORCHESTRATE_PROJECT_NUMBER, or ISSUE_DAG_PROJECT_NUMBER",
      ].join(" | ")
    );
  }

  const { items } = fetchProjectFieldMap({
    owner,
    projectNumber: options.projectNumber,
    cwd: options.repoRoot,
    fieldNames: [...CLOSE_RUNTIME_PROJECT_FIELD_NAMES],
  });

  const nodes: GithubRunNode[] = [];
  const seenTaskId = new Set<string>();

  for (const item of items) {
    if (item.contentType !== "Issue") continue;

    const runId = pickProjectField(item.fields, TASK_CONTROL_PLANE_FIELD_ALIASES.run_id);
    if (runId !== options.runId) continue;

    const taskId =
      pickProjectField(item.fields, TASK_CONTROL_PLANE_FIELD_ALIASES.task_id) ||
      extractTaskIdFromTitle(item.title);
    if (!taskId) {
      fail(
        `github close failed: Task ID is missing for run item (title=${item.title || "(untitled)"})`
      );
    }
    if (seenTaskId.has(taskId)) {
      fail(`github close failed: duplicate Task ID in run snapshot (${taskId})`);
    }
    seenTaskId.add(taskId);

    const rawStatus = pickProjectField(item.fields, TASK_CONTROL_PLANE_FIELD_ALIASES.status);
    const status = normalizeKanbanStatus(rawStatus);
    if (!status) {
      fail(
        `github close failed: invalid Status for task ${taskId} (raw=${rawStatus || "(empty)"})`
      );
    }

    nodes.push({
      task_id: taskId,
      status,
      run_id: runId,
      pr_url: pickProjectField(item.fields, TASK_CONTROL_PLANE_FIELD_ALIASES.pr_url),
      failure_reason: pickProjectField(
        item.fields,
        TASK_CONTROL_PLANE_FIELD_ALIASES.failure_reason
      ),
      updated_at: pickProjectField(item.fields, TASK_CONTROL_PLANE_FIELD_ALIASES.updated_at),
    });
  }

  if (nodes.length === 0) {
    fail(`github close failed: no Project-v2 task items found for run_id=${options.runId}`);
  }

  return nodes.sort((left, right) => left.task_id.localeCompare(right.task_id));
}

export function buildStateFromGithubRunNodes(
  githubNodes: GithubRunNode[],
  existingState: StatePayload | null
): StatePayload {
  const outNodes: Record<string, NodeState> = {};
  for (const item of githubNodes) {
    const existing = existingState?.nodes[item.task_id];
    outNodes[item.task_id] = {
      status: mapGithubRunNodeToCloseStatus(item),
      branch: String(existing?.branch || "").trim(),
      worktree: String(existing?.worktree || "").trim(),
      attempts: Number(existing?.attempts || 0),
      last_update: item.updated_at || String(existing?.last_update || "").trim() || nowIsoUtc(),
    };
  }
  return {
    updated_at: nowIsoUtc(),
    nodes: outNodes,
  };
}

export function buildGateFromGithubRunNodes(
  githubNodes: GithubRunNode[],
  state: StatePayload,
  existingGate: GateResultsPayload | null
): GateResultsPayload {
  const existingByNode = new Map<string, GateNode>(
    (existingGate?.nodes || []).map((entry) => [entry.node_id, entry])
  );
  const nodes: GateNode[] = githubNodes.map((item) => {
    const existing = existingByNode.get(item.task_id);
    const branch = state.nodes[item.task_id]?.branch || existing?.branch || "";
    return {
      node_id: item.task_id,
      status: mapGithubRunNodeToCloseStatus(item),
      branch,
      summary: existing?.summary || "",
      failure_reason: item.failure_reason || existing?.failure_reason || "",
      pr_url: item.pr_url || existing?.pr_url || "",
      artifacts: {
        status_json: existing?.artifacts?.status_json || "",
        conflict_json: existing?.artifacts?.conflict_json || "",
        review_json: existing?.artifacts?.review_json || "",
      },
    };
  });
  return {
    generated_at: nowIsoUtc(),
    state_updated_at: state.updated_at,
    nodes,
  };
}

function writeJsonFile(filePath: string, payload: unknown): void {
  const absolute = path.resolve(filePath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function parseCli(argv: string[]): Cli {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }

  const commandRaw = argv[0]?.trim() || "";
  if (
    commandRaw !== "verify" &&
    commandRaw !== "run" &&
    commandRaw !== "cleanup-plan" &&
    commandRaw !== "cleanup-apply"
  ) {
    fail(`unknown command: ${commandRaw}`);
  }

  const flags = new Map<string, string | true>();
  const allowedFlags = new Set([
    "state-dir",
    "session-id",
    "state-backend",
    "base-branch",
    "repository",
    "run-issue",
    "run-id",
    "followup-output",
    "closeout-output",
    "cleanup-plan-output",
    "cleanup-plan-input",
    "dry-run",
    "skip-task-status-sync",
    "skip-parent-issue-sync",
  ]);
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i] ?? "";
    if (!token.startsWith("--")) {
      fail(`unexpected positional argument: ${token}`);
    }

    const key = token.slice(2);
    if (!allowedFlags.has(key) && key !== "apply-cleanup") {
      fail(`unknown option: --${key}`);
    }
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      if (
        key === "dry-run" ||
        key === "skip-task-status-sync" ||
        key === "skip-parent-issue-sync"
      ) {
        flags.set(key, true);
        continue;
      }
      if (key === "apply-cleanup") {
        fail("--apply-cleanup is unsupported; use cleanup-apply command");
      }
      fail(`--${key} requires a value`);
    }
    if (key === "apply-cleanup") {
      fail("--apply-cleanup is unsupported; use cleanup-apply command");
    }
    if (key === "dry-run" || key === "skip-task-status-sync" || key === "skip-parent-issue-sync") {
      fail(`--${key} is a boolean flag and does not accept a value`);
      continue;
    }
    flags.set(key, value);
    i += 1;
  }

  const getFlag = (name: string): string => {
    const value = flags.get(name);
    if (value === true) fail(`--${name} requires a value`);
    return typeof value === "string" ? value.trim() : "";
  };

  return {
    command: commandRaw,
    stateDir: getFlag("state-dir"),
    sessionId: getFlag("session-id"),
    stateBackend: getFlag("state-backend"),
    baseBranch: getFlag("base-branch") || "main",
    repository: getFlag("repository"),
    runIssue: getFlag("run-issue"),
    runId: getFlag("run-id"),
    followupOutput: getFlag("followup-output"),
    closeoutOutput: getFlag("closeout-output"),
    cleanupPlanOutput: getFlag("cleanup-plan-output"),
    cleanupPlanInput: getFlag("cleanup-plan-input"),
    dryRun: flags.get("dry-run") === true,
    skipTaskStatusSync: flags.get("skip-task-status-sync") === true,
    skipParentIssueSync: flags.get("skip-parent-issue-sync") === true,
  };
}

function resolveRepoRoot(): string {
  const root = run("git", ["rev-parse", "--show-toplevel"], process.cwd()).trim();
  if (!root) {
    fail("failed to resolve repository root");
  }
  return root;
}

function resolveSessionId(value: string): string {
  return resolveSharedSessionId(value, {
    envValue: String(process.env.ORCHESTRATE_SESSION_ID || "").trim(),
    requiredMessage:
      "--session-id or ORCHESTRATE_SESSION_ID is required when --state-dir is omitted",
  });
}

function resolveRequiredRepository(repository: string): string {
  const text = repository.trim();
  if (!text) {
    fail("--repository is required");
  }
  parseRepositorySlug(text);
  return text;
}

function parseIssueNumber(value: string): number {
  const text = value.trim();
  const num = Number(text);
  if (!Number.isInteger(num) || num <= 0) {
    fail(`--run-issue must be a positive integer: ${value}`);
  }
  return num;
}

function parsePrNumberFromUrl(value: string): string {
  const text = value.trim();
  if (!text) return "";
  const matched = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)(?:[/?#].*)?$/i.exec(text);
  if (!matched) return "";
  return matched[1] || "";
}

function resolveOutputPath(value: string, fallback: string): string {
  const text = value.trim();
  return text ? path.resolve(text) : fallback;
}

function normalizeNodeState(value: unknown, nodeId: string): NodeState {
  if (!isObject(value)) {
    fail(`state.nodes.${nodeId} must be an object`);
  }
  return {
    status: String(value.status || "").trim(),
    branch: String(value.branch || "").trim(),
    worktree: String(value.worktree || "").trim(),
    attempts: Number(value.attempts || 0),
    last_update: String(value.last_update || "").trim(),
  };
}

function normalizeStatePayload(value: unknown): StatePayload {
  if (!isObject(value)) {
    fail("state.json must be a JSON object");
  }

  const rawNodes = value.nodes;
  if (!isObject(rawNodes)) {
    fail("state.json must include nodes object");
  }

  const nodes: Record<string, NodeState> = {};
  for (const [nodeId, rawNode] of Object.entries(rawNodes)) {
    const trimmed = nodeId.trim();
    if (!trimmed) continue;
    nodes[trimmed] = normalizeNodeState(rawNode, trimmed);
  }

  if (Object.keys(nodes).length === 0) {
    fail("state.json nodes must not be empty");
  }

  return {
    updated_at: String(value.updated_at || "").trim(),
    nodes,
  };
}

function normalizeGateNode(value: unknown, index: number): GateNode {
  if (!isObject(value)) {
    fail(`gate-results.nodes[${index}] must be an object`);
  }

  const artifactsRaw = isObject(value.artifacts)
    ? (value.artifacts as Record<string, unknown>)
    : {};

  return {
    node_id: String(value.node_id || "").trim(),
    status: String(value.status || "").trim(),
    branch: String(value.branch || "").trim(),
    summary: String(value.summary || "").trim(),
    failure_reason: String(value.failure_reason || "").trim(),
    pr_url: String(value.pr_url || "").trim(),
    artifacts: {
      status_json: String(artifactsRaw.status_json || "").trim(),
      conflict_json: String(artifactsRaw.conflict_json || "").trim(),
      review_json: String(artifactsRaw.review_json || "").trim(),
    },
  };
}

function normalizeGateResultsPayload(value: unknown): GateResultsPayload {
  if (!isObject(value)) {
    fail("gate-results.json must be a JSON object");
  }

  const rawNodes = Array.isArray(value.nodes) ? value.nodes : [];
  const nodes = rawNodes.map((entry, index) => normalizeGateNode(entry, index));

  return {
    generated_at: String(value.generated_at || "").trim(),
    state_updated_at: String(value.state_updated_at || "").trim(),
    nodes,
  };
}

function parseGithubIssueUrl(
  value: string,
  repository: string,
  field: string
): {
  issueNumber: number;
} {
  const text = value.trim();
  const matched = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)(?:[/?#].*)?$/i.exec(
    text
  );
  if (!matched) {
    fail(`${field} must be https://github.com/<owner>/<repo>/issues/<number>`);
  }

  const actualRepository = `${matched[1]}/${matched[2]}`.toLowerCase();
  const expectedRepository = repository.trim().toLowerCase();
  if (actualRepository !== expectedRepository) {
    fail(`${field} must reference https://github.com/${repository}/issues/<number>`);
  }

  return {
    issueNumber: Number(matched[3] || 0),
  };
}

export function resolveParentIssueSyncScopeFromRuntimeArtifacts(options: {
  stateDir: string;
  repository: string;
}): ParentIssueSyncScope {
  const executionPlanPath = path.join(options.stateDir, "inputs", "execution-plan.json");
  const executionPlanRaw = readJsonFile(executionPlanPath);
  if (!isObject(executionPlanRaw)) {
    fail("inputs/execution-plan.json must be a JSON object");
  }

  const issueTracking = executionPlanRaw.issue_tracking;
  if (!isObject(issueTracking)) {
    fail("inputs/execution-plan.json must include issue_tracking object");
  }

  const trackedRepository = String(issueTracking.repository || "").trim();
  if (!trackedRepository) {
    fail("inputs/execution-plan.json issue_tracking.repository is required");
  }
  if (trackedRepository.toLowerCase() !== options.repository.trim().toLowerCase()) {
    fail(
      `inputs/execution-plan.json issue_tracking.repository must match ${options.repository}: ${trackedRepository}`
    );
  }

  const sourceItems = executionPlanRaw.source_items;
  if (!Array.isArray(sourceItems) || sourceItems.length === 0) {
    fail("inputs/execution-plan.json source_items must be a non-empty array");
  }

  const parentIssueNumbers = new Set<number>();
  for (const [index, sourceItem] of sourceItems.entries()) {
    if (!isObject(sourceItem)) {
      fail(`inputs/execution-plan.json source_items[${index}] must be an object`);
    }

    const hasParentIssueNumberField = Object.hasOwn(sourceItem, "parent_issue_number");
    const hasParentIssueUrlField = Object.hasOwn(sourceItem, "parent_issue_url");
    const parentIssueNumber = Number(sourceItem.parent_issue_number || 0);
    const parentIssueUrl = String(sourceItem.parent_issue_url || "").trim();
    if (!hasParentIssueNumberField && !hasParentIssueUrlField) {
      continue;
    }
    if (hasParentIssueNumberField !== hasParentIssueUrlField) {
      fail(
        `inputs/execution-plan.json source_items[${index}] must set parent_issue_number and parent_issue_url together`
      );
    }
    if (!Number.isInteger(parentIssueNumber) || parentIssueNumber <= 0) {
      fail(
        `inputs/execution-plan.json source_items[${index}].parent_issue_number must be a positive integer`
      );
    }
    if (!parentIssueUrl) {
      fail(`inputs/execution-plan.json source_items[${index}].parent_issue_url is required`);
    }

    const parsedUrl = parseGithubIssueUrl(
      parentIssueUrl,
      options.repository,
      `inputs/execution-plan.json source_items[${index}].parent_issue_url`
    );
    if (parsedUrl.issueNumber !== parentIssueNumber) {
      fail(
        `inputs/execution-plan.json source_items[${index}].parent_issue_url issue number must match parent_issue_number (${parentIssueNumber})`
      );
    }

    parentIssueNumbers.add(parentIssueNumber);
  }

  return {
    executionPlanPath,
    parentIssueNumbers: [...parentIssueNumbers].sort((left, right) => left - right),
  };
}

export function validateCloseState(
  state: StatePayload,
  gate: GateResultsPayload,
  options: {
    requireBranch?: boolean;
  } = {}
): string[] {
  const errors: string[] = [];
  const requireBranch = options.requireBranch !== false;

  const gateByNode = new Map(gate.nodes.map((node) => [node.node_id, node]));

  for (const [nodeId, node] of Object.entries(state.nodes)) {
    if (!node.status) {
      errors.push(`node ${nodeId}: status is required`);
      continue;
    }
    if (!TERMINAL_STATUSES.has(node.status)) {
      errors.push(`node ${nodeId}: non-terminal status '${node.status}'`);
    }
    if (requireBranch && !node.branch) {
      errors.push(`node ${nodeId}: branch is required`);
    }

    if (!gateByNode.has(nodeId)) {
      errors.push(`node ${nodeId}: missing gate-results entry`);
    }
  }

  return errors;
}

function readStatusFiles(stateDir: string): Record<string, JsonObject> {
  const statusDir = path.join(stateDir, "status");
  if (!existsSync(statusDir)) {
    return {};
  }

  const files = readdirSync(statusDir).filter((name) => name.endsWith(".json"));
  const out: Record<string, JsonObject> = {};

  for (const fileName of files) {
    const nodeId = fileName.replace(/\.json$/, "").trim();
    if (!nodeId) continue;

    const fullPath = path.join(statusDir, fileName);
    const parsed = parseJson(readFileSync(fullPath, "utf8"), fullPath);
    out[nodeId] = isObject(parsed) ? parsed : {};
  }

  return out;
}

function readReviewFiles(stateDir: string): Record<string, ReviewArtifact> {
  const reviewDir = path.join(stateDir, "review");
  if (!existsSync(reviewDir)) {
    return {};
  }

  const files = readdirSync(reviewDir).filter((name) => name.endsWith(".json"));
  const out: Record<string, ReviewArtifact> = {};

  for (const fileName of files) {
    const nodeId = fileName.replace(/\.json$/, "").trim();
    if (!nodeId) continue;

    const fullPath = path.join(reviewDir, fileName);
    const parsed = normalizeReviewArtifact(parseJson(readFileSync(fullPath, "utf8"), fullPath));
    if (!parsed) continue;
    out[nodeId] = parsed;
  }

  return out;
}

export function extractResidueNodes(
  state: StatePayload,
  gate: GateResultsPayload,
  statusFiles: Record<string, JsonObject>,
  reviewFiles: Record<string, ReviewArtifact> = {}
): ResidueItem[] {
  const gateByNode = new Map(gate.nodes.map((entry) => [entry.node_id, entry]));
  const residues: ResidueItem[] = [];

  for (const [nodeId, node] of Object.entries(state.nodes)) {
    if (node.status === "done" || node.status === "merged") {
      continue;
    }

    const gateEntry = gateByNode.get(nodeId);
    const statusPayload = statusFiles[nodeId] || {};
    const reviewPayload = reviewFiles[nodeId];
    const reviewDecision = reviewPayload?.decision || "";
    const reviewSummary = reviewPayload?.summary || "";
    const reviewEscalation = reviewPayload?.escalation || { level: "none", reason: "" };
    const reviewFindings = reviewPayload?.findings || [];
    const summary =
      gateEntry?.summary ||
      String(statusPayload.summary || "").trim() ||
      (node.status === "ready_for_review" && !reviewDecision
        ? "waiting for reviewer-lane artifact"
        : reviewSummary) ||
      "close phase detected non-done terminal state";
    const failureReason =
      gateEntry?.failure_reason ||
      String(statusPayload.failure_reason || "").trim() ||
      (reviewDecision === "reject" ? "review_rejected" : "");

    residues.push({
      node_id: nodeId,
      status: gateEntry?.status || node.status,
      branch: gateEntry?.branch || node.branch,
      summary,
      failure_reason: failureReason,
      pr_url: gateEntry?.pr_url || String(statusPayload.pr_url || "").trim() || "",
      review_decision: reviewDecision,
      review_summary: reviewSummary,
      review_findings: reviewFindings,
      review_escalation: {
        level: reviewEscalation.level || "none",
        reason: reviewEscalation.reason || "",
      },
    });
  }

  return residues.sort((left, right) => left.node_id.localeCompare(right.node_id));
}

export function buildFollowupDrafts(residues: ResidueItem[]): JsonObject {
  return {
    generated_at: nowIsoUtc(),
    count: residues.length,
    items: residues.map((item) => ({
      source_node_id: item.node_id,
      source_branch: item.branch,
      source_status: item.status,
      source_failure_reason: item.failure_reason,
      source_pr_url: item.pr_url,
      suggested_task_type: "ops",
      suggested_status: "backlog",
      suggested_priority: 80,
      suggested_summary: `Re-implement ${item.node_id} from orchestrate-close residue (${item.status})`,
      suggested_acceptance_criteria: [
        "Root cause of the residue is identified and fixed",
        "Failed/blocked checks are made reproducible and passing",
        "Close phase residue report no longer includes this node",
      ],
      notes: item.summary,
      review: {
        decision: item.review_decision,
        summary: item.review_summary,
        findings: item.review_findings,
        escalation: item.review_escalation,
      },
    })),
  };
}

function classifyWorktrees(repoRoot: string, baseBranch: string): WorktreeClassification[] {
  const classifyScript = path.join(
    repoRoot,
    "tools",
    "orchestrator",
    "orchestrate",
    "worktree_classify.sh"
  );

  if (!existsSync(classifyScript)) {
    return [];
  }

  const result = runResult("bash", [classifyScript, "--base", baseBranch], repoRoot);
  if (result.status !== 0) {
    const detail = `${result.stderr}\n${result.stdout}`.trim();
    fail(`worktree classification failed: ${detail || `exit=${result.status}`}`);
  }

  const lines = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("No worktrees to classify."));

  return lines
    .map((line) => {
      const parts = line.split("\t");
      if (parts.length < 6) {
        return null;
      }
      const ahead = Number(parts[2].replace(/^ahead=/, "") || "0");
      const behind = Number(parts[3].replace(/^behind=/, "") || "0");
      const mergeReason = parts[5].replace(/^merge_reason=/, "").trim();

      return {
        group: parts[0],
        branch: parts[1],
        ahead: Number.isFinite(ahead) ? ahead : 0,
        behind: Number.isFinite(behind) ? behind : 0,
        worktree: parts[4],
        merge_reason: mergeReason,
      } satisfies WorktreeClassification;
    })
    .filter((entry): entry is WorktreeClassification => Boolean(entry));
}

export function buildCleanupTargets(
  state: StatePayload,
  gate: GateResultsPayload
): CleanupPlanTarget[] {
  const gateByNode = new Map(gate.nodes.map((entry) => [entry.node_id, entry]));
  const byPr = new Map<string, string>();
  const sortedNodes = Object.entries(state.nodes).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  for (const [taskId, node] of sortedNodes) {
    if (node.status !== "done" && node.status !== "merged") continue;
    const gateNode = gateByNode.get(taskId);
    const prUrl = String(gateNode?.pr_url || "").trim();
    const pr = parsePrNumberFromUrl(prUrl);
    if (!pr) {
      fail(`cleanup target requires valid pr_url for ${taskId}: ${prUrl || "(empty)"}`);
    }
    if (!byPr.has(pr)) {
      byPr.set(pr, taskId);
    }
  }

  return [...byPr.entries()]
    .map(([pr, taskId]) => ({ task_id: taskId, pr }))
    .sort((left, right) => {
      const leftNum = Number(left.pr);
      const rightNum = Number(right.pr);
      if (Number.isFinite(leftNum) && Number.isFinite(rightNum) && leftNum !== rightNum) {
        return leftNum - rightNum;
      }
      const byPr = left.pr.localeCompare(right.pr);
      if (byPr !== 0) return byPr;
      return left.task_id.localeCompare(right.task_id);
    });
}

export function buildCleanupPlan(options: {
  state: StatePayload;
  gate: GateResultsPayload;
  stateBackend: "github" | "local";
  repository: string;
  runIssueNumber: number;
  runId: string;
}): CleanupPlan {
  const targets = buildCleanupTargets(options.state, options.gate);
  const digestInput = [
    String(options.stateBackend),
    String(options.repository),
    String(options.runIssueNumber),
    String(options.runId),
    ...targets.map((target) => `${target.task_id}:pr-${target.pr}`),
  ].join("\n");
  const digest = createHash("sha256").update(digestInput).digest("hex").slice(0, 16);
  return {
    cleanup_plan_version: 1,
    generated_at: nowIsoUtc(),
    plan_id: `cp_${digest}`,
    state_backend: options.stateBackend,
    repository: options.repository,
    run_issue_number: options.runIssueNumber,
    run_id: options.runId,
    target_count: targets.length,
    targets,
  };
}

export function parseCleanupPlan(value: unknown): CleanupPlan {
  if (!isObject(value)) {
    fail("cleanup plan must be a JSON object");
  }
  const cleanupPlanVersion = Number(value.cleanup_plan_version || 0);
  if (cleanupPlanVersion !== 1) {
    fail("cleanup plan cleanup_plan_version must be 1");
  }
  const planId = String(value.plan_id || "").trim();
  if (!planId) {
    fail("cleanup plan plan_id is required");
  }
  const stateBackend = resolveStateBackend(String(value.state_backend || ""));
  const repository = String(value.repository || "").trim();
  if (!repository) {
    fail("cleanup plan repository is required");
  }
  const targetsRaw = Array.isArray(value.targets) ? value.targets : [];
  const targets: CleanupPlanTarget[] = [];
  const seenTarget = new Set<string>();
  for (const entry of targetsRaw) {
    if (!isObject(entry)) continue;
    const taskId = String(entry.task_id || "").trim();
    const pr = String(entry.pr || "").trim();
    if (!taskId || !pr) continue;
    const key = `${taskId}::${pr}`;
    if (seenTarget.has(key)) continue;
    seenTarget.add(key);
    targets.push({ task_id: taskId, pr });
  }
  const runIssueNumber = Number(value.run_issue_number || 0);
  if (!Number.isInteger(runIssueNumber) || runIssueNumber < 0) {
    fail("cleanup plan run_issue_number must be a non-negative integer");
  }
  const runId = String(value.run_id || "").trim();
  return {
    cleanup_plan_version: 1,
    generated_at: String(value.generated_at || "").trim(),
    plan_id: planId,
    state_backend: stateBackend,
    repository,
    run_issue_number: runIssueNumber,
    run_id: runId,
    target_count: targets.length,
    targets,
  };
}

function applyCleanupPlan(
  repoRoot: string,
  plan: CleanupPlan,
  options: {
    repositoryOverride: string;
    dryRun: boolean;
  }
): CleanupResult[] {
  const results: CleanupResult[] = [];
  for (const target of plan.targets) {
    const args = ["tools/apps/pr/cleanup-by-pr.sh", "--pr", target.pr];
    const repository = options.repositoryOverride.trim() || plan.repository.trim();
    if (repository) {
      args.push("--repository", repository);
    }
    if (options.dryRun) {
      args.push("--dry-run");
    }

    const result = runResult("bash", args, repoRoot);
    const ok = result.status === 0;
    let detail: string;
    if (!ok) {
      detail = `${result.stderr}\n${result.stdout}`.trim() || `exit=${result.status}`;
    } else if (options.dryRun) {
      detail = "planned(--dry-run)";
    } else {
      detail = "cleaned";
    }
    results.push({
      task_id: target.task_id,
      pr: target.pr,
      ok,
      detail,
    });
  }
  return results;
}

function resolveCleanupPlanOutputPath(cli: Cli, stateDir: string): string {
  return resolveOutputPath(
    cli.cleanupPlanOutput,
    resolveSessionArtifactPaths(stateDir).cleanupPlanJson
  );
}

function resolveCleanupPlanInputPath(cli: Cli, stateDir: string): string {
  return resolveOutputPath(
    cli.cleanupPlanInput,
    resolveSessionArtifactPaths(stateDir).cleanupPlanJson
  );
}

function syncProjectTaskStatus(options: {
  repoRoot: string;
  repository: string;
  stateDir: string;
  projectNumber: number;
  executionPlanPath: string;
}): JsonObject {
  const scriptPath = path.join(options.repoRoot, "scripts", "ops", "sync-project-task-status.ts");
  if (!existsSync(scriptPath)) {
    fail(`task status sync script not found: ${scriptPath}`);
  }

  const outputPath = path.join(options.stateDir, "task-status-sync.json");
  const args = [scriptPath, "--repository", options.repository, "--apply", "--output", outputPath];
  if (options.executionPlanPath.trim()) {
    args.push("--execution-plan", options.executionPlanPath);
  }
  if (options.projectNumber > 0) {
    args.push("--project-number", String(options.projectNumber));
  }

  const result = runResult("bun", args, options.repoRoot);
  if (result.status !== 0) {
    const detail = `${result.stderr}\n${result.stdout}`.trim();
    fail(`task status sync failed: ${detail || `exit=${result.status}`}`);
  }
  const summaryRaw = readJsonFile(outputPath);
  if (!isObject(summaryRaw)) {
    fail("task status sync summary must be a JSON object");
  }
  return {
    ...summaryRaw,
    output_path: outputPath,
  };
}

function emitSessionManifest(options: {
  stateDir: string;
  sessionId: string;
  stateBackend: "github" | "local";
  repository: string;
  command: "close:verify" | "close:run" | "close:cleanup-plan" | "close:cleanup-apply";
  fileOverride?: Parameters<typeof writeSessionArtifactManifest>[0]["fileOverride"];
}): void {
  if (!options.repository.trim()) return;

  writeSessionArtifactManifest({
    stateDir: options.stateDir,
    sessionId: options.sessionId,
    stateBackend: options.stateBackend,
    repository: options.repository,
    command: options.command,
    fileOverride: options.fileOverride,
  });
}

export function resolveGithubRunContextForClose(options: {
  cliRepository: string;
  cliRunId: string;
  cliRunIssue: string;
  stateBackend: "github" | "local";
  stateDir: string;
}): {
  repository: string;
  runId: string;
  runIssueNumber: number;
} {
  if (options.stateBackend !== "github") {
    return {
      repository: options.cliRepository.trim(),
      runId: options.cliRunId.trim(),
      runIssueNumber: options.cliRunIssue ? parseIssueNumber(options.cliRunIssue) : 0,
    };
  }

  const context = readGithubRunContextFile(options.stateDir);
  const cliRepository = options.cliRepository.trim();
  const repository = cliRepository || context.repository;
  if (!repository) {
    fail("github close requires repository from --repository or github-run-context.json");
  }
  if (cliRepository && cliRepository !== context.repository) {
    fail(`github close repository mismatch: cli=${cliRepository} context=${context.repository}`);
  }

  const runId = options.cliRunId.trim() || context.run_id;
  if (!runId) {
    fail("github close requires run_id from --run-id or github-run-context.json");
  }

  const runIssueNumber = options.cliRunIssue
    ? parseIssueNumber(options.cliRunIssue)
    : context.run_issue_number;

  return {
    repository,
    runId,
    runIssueNumber,
  };
}

export function shouldRunParentIssueSync(
  stateBackend: "github" | "local",
  skipFlag: boolean
): boolean {
  return stateBackend === "github" && !skipFlag;
}

function syncParentIssueStatus(options: {
  repoRoot: string;
  repository: string;
  stateDir: string;
  apply: boolean;
  parentIssueSyncScope: ParentIssueSyncScope;
}): JsonObject {
  const scriptPath = path.join(options.repoRoot, "scripts", "ops", "sync-parent-issue-status.ts");
  if (!existsSync(scriptPath)) {
    fail(`parent issue sync script not found: ${scriptPath}`);
  }
  const outputPath = resolveSessionArtifactPaths(options.stateDir).parentIssueSyncJson;
  if (options.parentIssueSyncScope.parentIssueNumbers.length === 0) {
    const summary = {
      generated_at: nowIsoUtc(),
      repository: options.repository,
      requested_parent_issue_numbers: [],
      applied: false,
      skipped: true,
      reason: "execution plan does not bound any parent issues",
    };
    writeJsonFile(outputPath, summary);
    return {
      ...summary,
      output_path: outputPath,
      bounded_scope: {
        execution_plan_path: options.parentIssueSyncScope.executionPlanPath,
        parent_issue_numbers: [],
      },
    };
  }

  const args = [scriptPath, "--repository", options.repository, "--output", outputPath];
  for (const parentIssueNumber of options.parentIssueSyncScope.parentIssueNumbers) {
    args.push("--parent-issue", String(parentIssueNumber));
  }
  if (options.apply) {
    args.push("--apply");
  } else {
    args.push("--dry-run");
  }

  const result = runResult("bun", args, options.repoRoot);
  if (result.status !== 0) {
    const detail = `${result.stderr}\n${result.stdout}`.trim();
    fail(`parent issue sync failed: ${detail || `exit=${result.status}`}`);
  }
  const summaryRaw = existsSync(outputPath) ? readJsonFile(outputPath) : {};
  if (!isObject(summaryRaw)) {
    fail("parent issue sync summary must be a JSON object");
  }
  return {
    ...summaryRaw,
    output_path: outputPath,
    bounded_scope: {
      execution_plan_path: options.parentIssueSyncScope.executionPlanPath,
      parent_issue_numbers: options.parentIssueSyncScope.parentIssueNumbers,
    },
  };
}

function main(): void {
  const cli = parseCli(process.argv.slice(2));
  const repoRoot = resolveRepoRoot();
  const stateBackend = resolveStateBackend(cli.stateBackend);
  let stateDirRaw = cli.stateDir ? path.resolve(cli.stateDir) : "";
  if (!stateDirRaw && cli.command === "cleanup-apply" && cli.cleanupPlanInput.trim()) {
    stateDirRaw = path.dirname(path.resolve(cli.cleanupPlanInput));
  }
  if (!stateDirRaw) {
    const sessionId = resolveSessionId(cli.sessionId);
    stateDirRaw = resolveStateDirForSession(repoRoot, sessionId);
  }
  const stateDir = enforceStateDirPolicy(repoRoot, stateDirRaw);
  const artifactPaths = resolveSessionArtifactPaths(stateDir);
  const manifestSessionId = cli.sessionId.trim() || path.basename(stateDir);
  if (cli.dryRun && cli.command !== "cleanup-apply") {
    fail("--dry-run is only supported for cleanup-apply");
  }

  if (cli.command === "cleanup-apply") {
    const cleanupPlanPath = resolveCleanupPlanInputPath(cli, stateDir);
    const cleanupPlan = parseCleanupPlan(readJsonFile(cleanupPlanPath));
    const cleanup = applyCleanupPlan(repoRoot, cleanupPlan, {
      repositoryOverride: cli.repository,
      dryRun: cli.dryRun,
    });
    const cleanupFailures = cleanup.filter((entry) => !entry.ok);
    if (cleanupFailures.length > 0) {
      const detail = cleanupFailures.map((entry) => `pr#${entry.pr}: ${entry.detail}`).join("\n- ");
      fail(`cleanup apply failed:\n- ${detail}`);
    }
    const summaryPath = resolveOutputPath(
      cli.closeoutOutput,
      artifactPaths.cleanupApplySummaryJson
    );
    writeJsonFile(summaryPath, {
      generated_at: nowIsoUtc(),
      state_backend: cleanupPlan.state_backend,
      repository: cli.repository.trim() || cleanupPlan.repository,
      run_issue_number: cleanupPlan.run_issue_number,
      run_id: cleanupPlan.run_id,
      cleanup_plan_id: cleanupPlan.plan_id,
      cleanup_plan_input: cleanupPlanPath,
      cleanup_count: cleanup.length,
      cleanup,
      dry_run: cli.dryRun,
    });
    emitSessionManifest({
      stateDir,
      sessionId: manifestSessionId,
      stateBackend: cleanupPlan.state_backend,
      repository: cli.repository.trim() || cleanupPlan.repository,
      command: "close:cleanup-apply",
      fileOverride: {
        cleanupPlanJson: cleanupPlanPath,
        cleanupApplySummaryJson: summaryPath,
      },
    });
    console.log(
      [
        "cleanup apply completed",
        `plan=${cleanupPlanPath}`,
        `count=${cleanup.length}`,
        `dry_run=${cli.dryRun ? "true" : "false"}`,
        `summary=${summaryPath}`,
      ].join(" | ")
    );
    return;
  }

  const statePath = artifactPaths.stateJson;
  const gateResultsPath = artifactPaths.gateResultsJson;
  const hasStateArtifact = existsSync(statePath);
  const hasGateArtifact = existsSync(gateResultsPath);
  if (stateBackend === "local") {
    if (!hasStateArtifact) {
      fail(`required artifact missing: ${statePath}`);
    }
    if (!hasGateArtifact) {
      fail(`required artifact missing: ${gateResultsPath}`);
    }
  }

  const stateRaw = hasStateArtifact ? readJsonFile(statePath) : null;
  const gateRaw = hasGateArtifact ? readJsonFile(gateResultsPath) : null;
  const existingState = hasStateArtifact ? normalizeStatePayload(stateRaw) : null;
  const existingGate = hasGateArtifact ? normalizeGateResultsPayload(gateRaw) : null;

  const githubRunContext = resolveGithubRunContextForClose({
    cliRepository: cli.repository,
    cliRunId: cli.runId,
    cliRunIssue: cli.runIssue,
    stateBackend,
    stateDir,
  });
  const resolvedRepository = resolveRequiredRepository(githubRunContext.repository);
  const runIssueNumber = githubRunContext.runIssueNumber;
  const runId = githubRunContext.runId;

  let state: StatePayload;
  let gate: GateResultsPayload;
  if (stateBackend === "github") {
    const githubNodes = loadGithubRunNodesFromProject({
      repoRoot,
      repository: resolvedRepository,
      runId,
      projectNumber: resolveProjectNumberHint(),
    });
    state = buildStateFromGithubRunNodes(githubNodes, existingState);
    gate = buildGateFromGithubRunNodes(githubNodes, state, existingGate);
  } else {
    if (!existingState || !existingGate) {
      fail("local close requires state.json and gate-results.json");
    }
    state = existingState;
    gate = existingGate;
  }

  const statusFiles = readStatusFiles(stateDir);
  const reviewFiles = readReviewFiles(stateDir);
  const validationErrors = validateCloseState(state, gate, {
    requireBranch: stateBackend !== "github",
  });
  if (validationErrors.length > 0) {
    fail(`close verification failed:\n- ${validationErrors.join("\n- ")}`);
  }

  const residues = extractResidueNodes(state, gate, statusFiles, reviewFiles);

  if (cli.command === "verify") {
    const closeoutPath = resolveOutputPath(cli.closeoutOutput, artifactPaths.closeoutSummaryJson);
    writeJsonFile(closeoutPath, {
      generated_at: nowIsoUtc(),
      state_dir: stateDir,
      state_backend: stateBackend,
      node_count: Object.keys(state.nodes).length,
      residue_count: residues.length,
      residue_nodes: residues.map((item) => item.node_id),
    });
    emitSessionManifest({
      stateDir,
      sessionId: manifestSessionId,
      stateBackend,
      repository: resolvedRepository,
      command: "close:verify",
      fileOverride: {
        closeoutSummaryJson: closeoutPath,
      },
    });
    console.log(
      `close verify passed | state_dir=${stateDir} | nodes=${Object.keys(state.nodes).length} | residue=${residues.length}`
    );
    return;
  }

  const cleanupPlan = buildCleanupPlan({
    state,
    gate,
    stateBackend,
    repository: resolvedRepository,
    runIssueNumber,
    runId,
  });
  const cleanupPlanPath = resolveCleanupPlanOutputPath(cli, stateDir);
  writeJsonFile(cleanupPlanPath, cleanupPlan);

  if (cli.command === "cleanup-plan") {
    const summaryPath = resolveOutputPath(cli.closeoutOutput, artifactPaths.cleanupPlanSummaryJson);
    writeJsonFile(summaryPath, {
      generated_at: nowIsoUtc(),
      state_dir: stateDir,
      state_backend: stateBackend,
      repository: resolvedRepository,
      run_issue_number: runIssueNumber,
      run_id: runId,
      cleanup_plan_output: cleanupPlanPath,
      cleanup_plan_id: cleanupPlan.plan_id,
      cleanup_target_count: cleanupPlan.target_count,
      cleanup_targets: cleanupPlan.targets,
    });
    emitSessionManifest({
      stateDir,
      sessionId: manifestSessionId,
      stateBackend,
      repository: resolvedRepository,
      command: "close:cleanup-plan",
      fileOverride: {
        cleanupPlanJson: cleanupPlanPath,
        cleanupPlanSummaryJson: summaryPath,
      },
    });
    console.log(
      [
        "cleanup plan generated",
        `state_dir=${stateDir}`,
        `targets=${cleanupPlan.target_count}`,
        `plan=${cleanupPlanPath}`,
        `summary=${summaryPath}`,
      ].join(" | ")
    );
    return;
  }

  const classifications = classifyWorktrees(repoRoot, cli.baseBranch);
  const cleanup: CleanupResult[] = cleanupPlan.targets.map((target) => ({
    task_id: target.task_id,
    pr: target.pr,
    ok: true,
    detail: "planned(--not-applied)",
  }));

  const followupPath = resolveOutputPath(cli.followupOutput, artifactPaths.followupDraftsJson);
  const followupResidues = residues;
  const skippedFollowupResidues: ResidueItem[] = [];
  if (followupResidues.length > 0) {
    writeJsonFile(followupPath, buildFollowupDrafts(followupResidues));
  }

  const closeoutPath = resolveOutputPath(cli.closeoutOutput, artifactPaths.closeoutSummaryJson);

  const nextActions: string[] = [];
  if (followupResidues.length > 0) {
    nextActions.push(`Create follow-up task issues from ${followupPath}`);
  }
  const escalatedResidues = followupResidues.filter(
    (item) => item.review_escalation.level && item.review_escalation.level !== "none"
  );
  if (escalatedResidues.length > 0) {
    nextActions.push(
      `Resolve reviewer escalations for ${escalatedResidues.map((item) => item.node_id).join(", ")}`
    );
  }
  if (cleanup.length === 0) {
    nextActions.push("No merged task PRs required cleanup plan");
  } else {
    nextActions.push(`Apply cleanup via cleanup-apply using plan ${cleanupPlanPath}`);
  }

  let taskStatusSync: JsonObject = {};
  if (stateBackend === "github" && !cli.skipTaskStatusSync) {
    taskStatusSync = syncProjectTaskStatus({
      repoRoot,
      repository: resolvedRepository,
      stateDir,
      projectNumber: resolveProjectNumberHint(),
      executionPlanPath: artifactPaths.executionPlanJson,
    });
  }

  let parentIssueSync: JsonObject = {};
  if (shouldRunParentIssueSync(stateBackend, cli.skipParentIssueSync)) {
    const parentIssueSyncScope = resolveParentIssueSyncScopeFromRuntimeArtifacts({
      stateDir,
      repository: resolvedRepository,
    });
    parentIssueSync = syncParentIssueStatus({
      repoRoot,
      repository: resolvedRepository,
      stateDir,
      apply: true,
      parentIssueSyncScope,
    });
  }

  writeJsonFile(closeoutPath, {
    generated_at: nowIsoUtc(),
    state_dir: stateDir,
    state_backend: stateBackend,
    repository: resolvedRepository,
    node_count: Object.keys(state.nodes).length,
    residue_count: residues.length,
    residue: residues,
    followup_residue_count: followupResidues.length,
    followup_residue: followupResidues,
    skipped_followup_residue_count: skippedFollowupResidues.length,
    skipped_followup_residue: skippedFollowupResidues,
    cleanup_plan_output: cleanupPlanPath,
    cleanup_plan_id: cleanupPlan.plan_id,
    cleanup,
    task_status_sync: taskStatusSync,
    parent_issue_sync: parentIssueSync,
    worktree_classification: classifications,
    followup_output: followupResidues.length > 0 ? followupPath : "",
    cleanup_apply_requested: false,
    next_actions: nextActions,
  });
  emitSessionManifest({
    stateDir,
    sessionId: manifestSessionId,
    stateBackend,
    repository: resolvedRepository,
    command: "close:run",
    fileOverride: {
      cleanupPlanJson: cleanupPlanPath,
      followupDraftsJson: followupPath,
      closeoutSummaryJson: closeoutPath,
      parentIssueSyncJson: isObject(parentIssueSync)
        ? String(parentIssueSync.output_path || "").trim() || undefined
        : undefined,
    },
  });

  console.log(
    [
      "close run completed",
      `state_dir=${stateDir}`,
      `nodes=${Object.keys(state.nodes).length}`,
      `residue=${residues.length}`,
      `cleanup=${cleanup.length}`,
      `closeout=${closeoutPath}`,
    ].join(" | ")
  );
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(`close_runtime failed: ${(error as Error).message}`);
    process.exit(1);
  }
}
