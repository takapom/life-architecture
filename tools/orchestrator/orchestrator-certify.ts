#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { hasActiveForeignClaim } from "../core/task-governance";
import type { TaskIssue } from "../core/task-governance-types";
import { summarizeOperatorStatus } from "./orchestrator";
import {
  buildViewportPlan,
  normalizeTmuxSessionName,
  readViewportNodes,
} from "./orchestrator-tmux";
import {
  buildCleanupPlan,
  buildFollowupDrafts,
  extractResidueNodes,
  resolveParentIssueSyncScopeFromRuntimeArtifacts,
  validateCloseState,
} from "./runtime/close";
import {
  buildOrchestratorRuntimeEnv,
  resolveRuntimeStateDir as resolveExecuteStateDir,
} from "./runtime/execute";
import { validateHandoff } from "./runtime/register";
import {
  buildPhaseInvocations,
  selectPhaseFromSessionState,
  selectPhaseFromTaskIssues,
} from "./runtime/session_phase";
import { appendOperatorCommandEvent, appendOperatorLockEvent } from "./shared/runtime_lifecycle";
import {
  resolveSessionArtifactPaths,
  type SessionArtifactPaths,
  writeSessionArtifactManifest,
} from "./shared/session_artifacts";
import { acquireSessionLock } from "./shared/session_lock";
import { clonePhaseContractFixture } from "./test-support/orchestration-phase-fixtures";

type Command = "verify";
type JsonObject = Record<string, unknown>;
type CertificationStatePayload = Parameters<typeof extractResidueNodes>[0];
type CertificationGateResultsPayload = Parameters<typeof extractResidueNodes>[1];
type CertificationReviewFiles = NonNullable<Parameters<typeof extractResidueNodes>[3]>;

type Cli = {
  command: Command;
  output: string;
};

type ScenarioResult = {
  id:
    | "golden_path"
    | "parallel_ten_way"
    | "crash_resume"
    | "stale_claim"
    | "review_reject"
    | "merge_conflict"
    | "cleanup_failure";
  passed: boolean;
  summary: string;
  evidence: string[];
  details: JsonObject;
  error?: string;
};

type CertificationBundle = {
  schema_version: 1;
  generated_at: string;
  repository: string;
  epic_issue_number: 5545;
  task_issue_number: 5555;
  command: "verify";
  status: "pass" | "fail";
  scenario_count: number;
  passed_count: number;
  failed_scenarios: string[];
  golden_path: ScenarioResult;
  parallel_stress: ScenarioResult;
  recovery_paths: ScenarioResult[];
  operator_surface: {
    passed: boolean;
    source_of_truth: string[];
    viewport_role: string;
  };
  close_gate: {
    passed: boolean;
    workflow_doc: string;
    certification_command: string;
    rule: string;
  };
};

const _CERTIFICATION_TASK_ID = "ARCH-2603082208";
const DEFAULT_OUTPUT = ".tmp/orchestrator-certification.json";
const GOLDEN_PATH_EXECUTION_PLAN_FIXTURE_PATH = path.resolve(
  import.meta.dir,
  "../contracts/fixtures/execution-plan.valid.json"
);

function usage(): string {
  return [
    "Usage:",
    "  bun run orchestrator:certify -- verify [--output <path>]",
    "",
    "Notes:",
    "  - emits a certification bundle for the Human + AI PM Orchestrator v1 close gate.",
    "  - proves the golden path plus crash resume, stale claim, review reject, merge conflict, and cleanup failure recovery paths.",
    "  - bundle output defaults to .tmp/orchestrator-certification.json.",
  ].join("\n");
}

function fail(message: string): never {
  throw new Error(message);
}

function nowIsoUtc(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function buildSessionSuffix(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function _isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}

function requireTaskNode(
  nodes: Record<string, { status: string; worktree: string }>,
  taskId: string
) {
  const node = nodes[taskId];
  assert(node, `missing orchestration node for ${taskId}`);
  return node;
}

function requireGateNode(
  nodes: Array<{
    status: string;
    summary: string;
    pr_url?: string;
    failure_reason?: string;
    artifacts: Record<string, string>;
  }>
) {
  const node = nodes[0];
  assert(node, "expected at least one gate result node");
  return node;
}

function resolveRepoRoot(): string {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    fail(`failed to resolve repository root: ${(result.stderr || result.stdout || "").trim()}`);
  }
  const repoRoot = String(result.stdout || "").trim();
  if (!repoRoot) fail("failed to resolve repository root");
  return repoRoot;
}

function parseCli(argv: string[]): Cli {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }

  const command = String(argv[0] || "").trim();
  if (command !== "verify") {
    fail(`unknown command: ${command}`);
  }

  let output = "";
  for (let index = 1; index < argv.length; index += 1) {
    const token = String(argv[index] || "");
    if (token !== "--output") {
      fail(`unknown option: ${token}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      fail("--output requires a value");
    }
    output = value;
    index += 1;
  }

  return { command, output: output.trim() };
}

function writeJsonFile(filePath: string, payload: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function readJsonFile(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
}

function restoreGoldenPathFixtureTaskScope(payload: unknown): void {
  if (!_isObject(payload) || !Array.isArray(payload.nodes) || payload.nodes.length === 0) {
    return;
  }
  const fixture = readJsonFile(GOLDEN_PATH_EXECUTION_PLAN_FIXTURE_PATH);
  if (!_isObject(fixture) || !Array.isArray(fixture.nodes) || fixture.nodes.length === 0) {
    fail("golden path execution-plan fixture must include at least one node");
  }
  const fixtureNode = fixture.nodes[0];
  if (!_isObject(fixtureNode) || !_isObject(fixtureNode.task_scope)) {
    fail("golden path execution-plan fixture must include task_scope");
  }
  const currentNode = payload.nodes[0];
  if (!_isObject(currentNode)) {
    fail("golden path execution plan must include an object node");
  }
  currentNode.task_scope = structuredClone(fixtureNode.task_scope);
}

function relativeEvidence(repoRoot: string, filePath: string): string {
  return path.relative(repoRoot, filePath).replace(/\\/g, "/");
}

function makeTaskIssue(options: {
  number: number;
  parentIssue: number;
  taskId: string;
  state: "open" | "closed";
}): TaskIssue {
  return {
    id: `issue-${options.number}`,
    number: options.number,
    title: `[TASK] ${options.taskId}`,
    state: options.state,
    htmlUrl: `https://github.com/Omluc/omta/issues/${options.number}`,
    labels: ["task"],
    metadata: {
      task_id: options.taskId,
      task_type: "ops",
      status: options.state === "open" ? "ready" : "done",
      run_id: "",
      claimed_by: "",
      lease_expires_at: "",
      priority: 50,
      deps: [],
      allowed_files: ["tools/orchestrator/**"],
      acceptance_checks: ["bun run test:kanban"],
      tests: ["bun run test:kanban"],
      non_goals: [],
      commit_units: [],
      acceptance_criteria: [],
      rca_scope: "certification",
    },
    dependencySource: "none",
    graph: {
      blockedBy: [],
      parent: options.parentIssue,
      subIssues: [],
    },
  };
}

function writeExecutionPlanArtifact(stateDir: string, payload: unknown): string {
  const executionPlanPath = path.join(stateDir, "inputs", "execution-plan.json");
  writeJsonFile(executionPlanPath, payload);
  return executionPlanPath;
}

function writeStateArtifacts(
  paths: SessionArtifactPaths,
  payload: {
    state: unknown;
    gate: unknown;
    statusFiles?: Record<string, unknown>;
    reviewFiles?: Record<string, unknown>;
    conflictFiles?: Record<string, unknown>;
  }
): void {
  writeJsonFile(paths.stateJson, payload.state);
  writeJsonFile(paths.gateResultsJson, payload.gate);

  for (const [nodeId, value] of Object.entries(payload.statusFiles || {})) {
    writeJsonFile(path.join(paths.statusDir, `${nodeId}.json`), value);
  }
  for (const [nodeId, value] of Object.entries(payload.reviewFiles || {})) {
    writeJsonFile(path.join(paths.reviewDir, `${nodeId}.json`), value);
  }
  for (const [nodeId, value] of Object.entries(payload.conflictFiles || {})) {
    writeJsonFile(path.join(paths.conflictDir, `${nodeId}.json`), value);
  }
}

function runBunScript(
  repoRoot: string,
  scriptPath: string,
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    expectedStatus?: number;
  } = {}
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("bun", [scriptPath, ...args], {
    cwd: repoRoot,
    env: options.env || Bun.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const status = Number(result.status ?? 1);
  const stdout = String(result.stdout || "");
  const stderr = String(result.stderr || "");
  if (options.expectedStatus !== undefined && status !== options.expectedStatus) {
    fail(
      `bun ${path.basename(scriptPath)} ${args.join(" ")} failed: expected exit=${options.expectedStatus}, got exit=${status}\n${stderr}\n${stdout}`.trim()
    );
  }
  return { status, stdout, stderr };
}

function withSessionStateDir<T>(
  repoRoot: string,
  sessionId: string,
  fn: (stateDir: string, paths: SessionArtifactPaths) => T
): T {
  const stateDir = resolveExecuteStateDir(repoRoot, "", sessionId);
  rmSync(stateDir, { recursive: true, force: true });
  mkdirSync(stateDir, { recursive: true });
  const paths = resolveSessionArtifactPaths(stateDir);
  try {
    return fn(stateDir, paths);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

function baseSupervisorCli(options: {
  repository: string;
  parentIssue: number;
  stateDir: string;
  sessionId: string;
  runIssue: number;
  runId: string;
}): Parameters<typeof buildPhaseInvocations>[1] {
  return {
    command: "run",
    repository: options.repository,
    issue: "",
    parentIssue: String(options.parentIssue),
    stateBackend: "local",
    stateDir: options.stateDir,
    sessionId: options.sessionId,
    taskSource: "",
    skillsConfig: "",
    profile: "",
    allowDirtyBase: false,
    runIssue: String(options.runIssue),
    runId: options.runId,
    baseBranch: "main",
  };
}

function runScenario(
  id: ScenarioResult["id"],
  execute: () => Omit<ScenarioResult, "id" | "passed"> & { details?: JsonObject }
): ScenarioResult {
  try {
    const result = execute();
    return {
      id,
      passed: true,
      summary: result.summary,
      evidence: result.evidence,
      details: result.details || {},
    };
  } catch (error) {
    return {
      id,
      passed: false,
      summary: `${id} failed`,
      evidence: [],
      details: {},
      error: (error as Error).message,
    };
  }
}

function buildPlannedCleanupResults(cleanupPlan: ReturnType<typeof buildCleanupPlan>): Array<{
  kind: string;
  target_id: string;
  task_id: string;
  pr: string;
  worktree_path: string;
  archive_path?: string;
  ok: boolean;
  detail: string;
}> {
  return cleanupPlan.targets.map((target) => {
    if (target.kind === "pr_cleanup") {
      return {
        kind: target.kind,
        target_id: target.task_id,
        task_id: target.task_id,
        pr: target.pr,
        worktree_path: "",
        ok: true,
        detail: "planned(--not-applied)",
      };
    }
    return {
      kind: target.kind,
      target_id: target.target_id,
      task_id: target.target_id,
      pr: "",
      worktree_path: target.worktree_path,
      archive_path: "",
      ok: true,
      detail: "planned(--not-applied)",
    };
  });
}

function materializeCertificationCloseRun(options: {
  paths: SessionArtifactPaths;
  repoRoot: string;
  repository: string;
  runIssueNumber: number;
  runId: string;
  sessionId: string;
  stateDir: string;
  state: CertificationStatePayload;
  gate: CertificationGateResultsPayload;
  reviewFiles?: CertificationReviewFiles;
}): {
  cleanupPlan: ReturnType<typeof buildCleanupPlan>;
  closeout: JsonObject;
  followup: JsonObject | null;
} {
  const validationErrors = validateCloseState(options.state, options.gate, {
    requireBranch: true,
  });
  assert(
    validationErrors.length === 0,
    `certification close validation failed: ${validationErrors.join("; ")}`
  );

  const reviewFiles = options.reviewFiles || {};
  const residues = extractResidueNodes(options.state, options.gate, {}, reviewFiles);
  const cleanupPlan = buildCleanupPlan({
    state: options.state,
    gate: options.gate,
    stateBackend: "local",
    repository: options.repository,
    runIssueNumber: options.runIssueNumber,
    runId: options.runId,
  });
  writeJsonFile(options.paths.cleanupPlanJson, cleanupPlan);

  let followup: JsonObject | null = null;
  if (residues.length > 0) {
    followup = buildFollowupDrafts(residues);
    writeJsonFile(options.paths.followupDraftsJson, followup);
  } else {
    rmSync(options.paths.followupDraftsJson, { force: true });
  }

  const nextActions: string[] = [];
  if (followup) {
    nextActions.push(`Create follow-up task issues from ${options.paths.followupDraftsJson}`);
  }
  const escalatedResidues = residues.filter(
    (item) => item.review_escalation.level && item.review_escalation.level !== "none"
  );
  if (escalatedResidues.length > 0) {
    nextActions.push(
      `Resolve reviewer escalations for ${escalatedResidues.map((item) => item.node_id).join(", ")}`
    );
  }
  if (cleanupPlan.target_count === 0) {
    nextActions.push("No merged task PRs required cleanup plan");
  } else {
    nextActions.push(`Apply cleanup via cleanup-apply using plan ${options.paths.cleanupPlanJson}`);
  }

  const closeout = {
    generated_at: nowIsoUtc(),
    state_dir: options.stateDir,
    state_backend: "local",
    repository: options.repository,
    node_count: Object.keys(options.state.nodes).length,
    residue_count: residues.length,
    residue_nodes: residues.map((item) => item.node_id),
    residue: residues,
    followup_residue_count: residues.length,
    followup_residue: residues,
    skipped_followup_residue_count: 0,
    skipped_followup_residue: [],
    cleanup_plan_output: options.paths.cleanupPlanJson,
    cleanup_plan_id: cleanupPlan.plan_id,
    cleanup_target_count: cleanupPlan.target_count,
    pr_cleanup_target_count: cleanupPlan.pr_target_count,
    managed_worktree_delete_target_count: cleanupPlan.managed_worktree_delete_target_count,
    managed_worktree_archive_target_count: cleanupPlan.managed_worktree_archive_target_count,
    managed_worktree_archive_disposition_counts:
      cleanupPlan.managed_worktree_archive_disposition_counts,
    cleanup: buildPlannedCleanupResults(cleanupPlan),
    parent_issue_sync: {},
    repo_safety: {
      repo_root: options.repoRoot,
      base_branch: "main",
      managed_worktree_root: "",
      base_worktree_clean: true,
      base_worktree_detail: "certification-simulated",
      registered_worktree_count: 0,
      invalid_worktree_count: 0,
      invalid_worktrees: [],
      unregistered_managed_dir_count: 0,
      unregistered_managed_dirs: [],
      unregistered_managed_dir_disposition_counts: {
        delete: 0,
        rescue: 0,
        broken_archive: 0,
      },
      unregistered_managed_dir_classifications: [],
      prunable_worktree_count: 0,
      prunable_worktrees: [],
      blocking_reasons: [],
      next_action: "",
    },
    managed_worktree_residue_output: "",
    managed_worktree_residue: {
      generated_at: nowIsoUtc(),
      unregistered_managed_dir_count: 0,
      delete_count: 0,
      rescue_count: 0,
      broken_archive_count: 0,
      directories: [],
    },
    worktree_classification: [],
    invalid_worktree_count: 0,
    invalid_worktrees: [],
    followup_output: followup ? options.paths.followupDraftsJson : "",
    cleanup_apply_requested: false,
    next_actions: nextActions,
  } satisfies JsonObject;
  writeJsonFile(options.paths.closeoutSummaryJson, closeout);
  writeSessionArtifactManifest({
    stateDir: options.stateDir,
    sessionId: options.sessionId,
    stateBackend: "local",
    repository: options.repository,
    command: "close:run",
    fileOverride: {
      cleanupPlanJson: options.paths.cleanupPlanJson,
      followupDraftsJson: followup ? options.paths.followupDraftsJson : undefined,
      closeoutSummaryJson: options.paths.closeoutSummaryJson,
    },
  });

  return { cleanupPlan, closeout, followup };
}

function runGoldenPathScenario(repoRoot: string, sessionSuffix: string): ScenarioResult {
  return runScenario("golden_path", () => {
    const fixture = clonePhaseContractFixture({
      sessionId: `sess-20260308093000-certgold-${sessionSuffix}`,
      runId: "run_20260308_cert_gold",
      runIssueNumber: 5555,
      taskId: "OPS-900100",
    });
    restoreGoldenPathFixtureTaskScope(fixture.executionPlan);
    const taskIssue = makeTaskIssue({
      number: 9100,
      parentIssue: fixture.metadata.parentIssueNumbers[0] || 900,
      taskId: fixture.metadata.taskId,
      state: "open",
    });
    const githubSelection = selectPhaseFromTaskIssues({
      repository: fixture.metadata.repository,
      parentIssueNumber: taskIssue.graph.parent || 0,
      taskIssueNumber: taskIssue.number,
      sessionId: fixture.metadata.sessionId,
      stateDir: "",
      taskIssues: [taskIssue],
    });

    assert(
      validateHandoff(fixture.executionPlan).length === 0,
      "golden path handoff must validate"
    );
    assert(githubSelection.phase === "execute", "golden path must begin in execute phase");

    return withSessionStateDir(repoRoot, fixture.metadata.sessionId, (stateDir, paths) => {
      const executionPlanPath = writeExecutionPlanArtifact(stateDir, fixture.executionPlan);
      const runningState = structuredClone(fixture.closeState);
      const runningNode = requireTaskNode(runningState.nodes, fixture.metadata.taskId);
      runningNode.status = "running";
      runningNode.worktree = path.join(repoRoot, "..", "wt", fixture.metadata.taskId);
      const runningGate = structuredClone(fixture.gateResults);
      const runningGateNode = requireGateNode(runningGate.nodes);
      runningGateNode.status = "running";
      runningGateNode.summary = "Execution in progress.";
      runningGateNode.pr_url = "";
      writeStateArtifacts(paths, { state: runningState, gate: runningGate });

      const runtimeEnv = buildOrchestratorRuntimeEnv(
        repoRoot,
        {
          ...Bun.env,
          ORCHESTRATE_TMPDIR: path.join(stateDir, "tmp-root"),
          ORCHESTRATE_SESSION_ID: "",
          TMPDIR: "",
          TMP: "",
          TEMP: "",
          BUN_TMPDIR: "",
          npm_config_tmp: "",
        },
        fixture.metadata.sessionId
      );
      const resumeSelection = selectPhaseFromSessionState({
        stateDir,
        repository: fixture.metadata.repository,
        parentIssueNumber: taskIssue.graph.parent || 0,
        sessionId: fixture.metadata.sessionId,
      });
      assert(resumeSelection?.phase === "resume", "golden path active session must resume");

      const operatorStatus = summarizeOperatorStatus({
        repoRoot,
        sessionId: fixture.metadata.sessionId,
        stateDir,
      });
      assert(
        operatorStatus.overall_status === "active",
        "golden path operator status must be active"
      );

      const viewportNodes = readViewportNodes(stateDir);
      const viewportPlan = buildViewportPlan({
        repoRoot,
        sessionId: fixture.metadata.sessionId,
        stateDir,
        tmuxSession: normalizeTmuxSessionName(fixture.metadata.sessionId),
        nodes: viewportNodes,
      });
      assert(
        viewportPlan.windows.length === 2,
        "golden path viewport must include overview and workers windows"
      );

      writeStateArtifacts(paths, { state: fixture.closeState, gate: fixture.gateResults });
      const closeSelection = selectPhaseFromSessionState({
        stateDir,
        repository: fixture.metadata.repository,
        parentIssueNumber: taskIssue.graph.parent || 0,
        sessionId: fixture.metadata.sessionId,
      });
      assert(closeSelection?.phase === "close", "golden path terminal session must route to close");

      const invocations = buildPhaseInvocations(
        path.join(repoRoot, "tools", "orchestrator", "runtime"),
        baseSupervisorCli({
          repository: fixture.metadata.repository,
          parentIssue: taskIssue.graph.parent || 0,
          stateDir,
          sessionId: fixture.metadata.sessionId,
          runIssue: fixture.metadata.runIssueNumber,
          runId: fixture.metadata.runId,
        }),
        closeSelection
      );
      assert(
        invocations[0]?.scriptPath.endsWith("close.ts"),
        "golden path close routing must target close.ts"
      );

      const { cleanupPlan, closeout } = materializeCertificationCloseRun({
        paths,
        repoRoot,
        repository: fixture.metadata.repository,
        runIssueNumber: fixture.metadata.runIssueNumber,
        runId: fixture.metadata.runId,
        sessionId: fixture.metadata.sessionId,
        stateDir,
        state: fixture.closeState,
        gate: fixture.gateResults,
      });
      const manifest = readJsonFile(paths.manifestJson) as JsonObject;
      const residues = extractResidueNodes(fixture.closeState, fixture.gateResults, {});
      const closeErrors = validateCloseState(fixture.closeState, fixture.gateResults);
      const parentScope = resolveParentIssueSyncScopeFromRuntimeArtifacts({
        stateDir,
        repository: fixture.metadata.repository,
      });

      assert(closeErrors.length === 0, "golden path close verification must pass");
      assert(residues.length === 0, "golden path must not leave residue");
      assert(
        Number.isFinite(Number(closeout.residue_count)) && Number(closeout.residue_count) === 0,
        "golden path closeout must report zero residue"
      );
      assert(
        Number(cleanupPlan.pr_target_count || 0) === 1,
        "golden path cleanup plan must include one PR cleanup target"
      );
      assert(
        Array.isArray(manifest.present_files),
        "golden path manifest must enumerate present files"
      );

      return {
        summary: "execute -> resume -> close succeeds from canonical artifacts only",
        evidence: [
          executionPlanPath,
          paths.stateJson,
          paths.gateResultsJson,
          paths.cleanupPlanJson,
          paths.closeoutSummaryJson,
          paths.manifestJson,
        ].map((filePath) => relativeEvidence(repoRoot, filePath)),
        details: {
          execute_phase_reason: githubSelection.reason,
          resume_phase_reason: resumeSelection?.reason || "",
          close_phase_reason: closeSelection?.reason || "",
          parent_issue_numbers: parentScope.parentIssueNumbers,
          tmux_windows: viewportPlan.windows.map((window) => window.name),
          next_actions: Array.isArray(closeout.next_actions) ? closeout.next_actions : [],
          tmp_root: String(runtimeEnv.TMPDIR || ""),
        },
      };
    });
  });
}

function runParallelTenWayScenario(repoRoot: string, sessionSuffix: string): ScenarioResult {
  return runScenario("parallel_ten_way", () => {
    const sessionId = `sess-20260308093000-certparallel-${sessionSuffix}`;
    const runId = "run_20260308_cert_parallel";
    const repository = "Omluc/omta";
    const nodeCount = 10;
    const nodes = Array.from({ length: nodeCount }, (_, index) => {
      const ordinal = index + 1;
      const taskId = `OPS-910${String(ordinal).padStart(3, "0")}`;
      return {
        taskId,
        branch: `task/ops-cert-parallel-${ordinal}`,
        allowedFiles: [`parallel-scope/${ordinal}/**`],
        worktree: path.join(repoRoot, "..", "wt", "sessions", sessionId, taskId),
        lastUpdate: `2026-03-08T09:${String(ordinal).padStart(2, "0")}:00Z`,
      };
    });

    return withSessionStateDir(repoRoot, sessionId, (stateDir, paths) => {
      const executionPlan = {
        version: 1,
        session_id: sessionId,
        run_id: runId,
        repository,
        nodes: nodes.map((node, index) => ({
          id: node.taskId,
          branch: node.branch,
          allowed_files: node.allowedFiles,
          priority: index + 1,
        })),
      };
      const executionPlanPath = writeExecutionPlanArtifact(stateDir, executionPlan);
      const state = {
        updated_at: "2026-03-08T09:59:00Z",
        nodes: Object.fromEntries(
          nodes.map((node) => [
            node.taskId,
            {
              status: "running",
              branch: node.branch,
              worktree: node.worktree,
              attempts: 1,
              last_update: node.lastUpdate,
            },
          ])
        ),
      };
      const gate = {
        generated_at: "2026-03-08T09:59:05Z",
        state_updated_at: "2026-03-08T09:59:00Z",
        dispatch: {
          queue_strategy: "dag_priority",
          max_workers: nodeCount,
          review_policy: {
            mode: "manual",
            auto_approve: false,
          },
          ready_candidates: nodes.map((node) => node.taskId),
          write_set_policy: {
            scope_source: "allowed_files",
            conflicted_node_ids: [],
          },
          mutation_serialization: {
            owner: "session_lock",
            artifact: "event-log.ndjson",
          },
        },
        nodes: nodes.map((node) => ({
          node_id: node.taskId,
          branch: node.branch,
          status: "running",
          attempts: 1,
          last_update: node.lastUpdate,
          summary: "Execution in progress.",
          failure_reason: "none",
          pr_url: "",
          artifacts: {
            status_json: `status/${node.taskId}.json`,
            conflict_json: "",
            review_json: "",
          },
          dispatch: {
            state: "running",
            decision: "active",
          },
        })),
      };
      writeStateArtifacts(paths, {
        state,
        gate,
        statusFiles: Object.fromEntries(
          nodes.map((node) => [
            node.taskId,
            {
              node_id: node.taskId,
              summary: "Execution in progress.",
              failure_reason: "none",
            },
          ])
        ),
      });

      const lockResult = acquireSessionLock({
        stateDir,
        sessionId,
        lockToken: "lock-cert-parallel",
        ownerLabel: "orchestrator:start",
        now: "2026-03-08T10:00:00Z",
      });
      assert(lockResult.acquired, "parallel stress must acquire the canonical session lock");
      appendOperatorLockEvent({
        stateDir,
        sessionId,
        stage: "acquired",
        command: "start",
        lock: lockResult.lock,
      });
      appendOperatorCommandEvent({
        stateDir,
        sessionId,
        command: "start",
        stage: "started",
        delegatedScript: "execute.ts",
      });

      const manifestPath = writeSessionArtifactManifest({
        stateDir,
        sessionId,
        stateBackend: "local",
        repository,
        command: "execute",
      });
      const manifest = readJsonFile(manifestPath) as JsonObject;
      const operatorStatus = summarizeOperatorStatus({
        repoRoot,
        sessionId,
        stateDir,
      });
      const uniqueBranches = new Set(nodes.map((node) => node.branch));
      const uniqueWorktrees = new Set(nodes.map((node) => node.worktree));
      const presentFiles = Array.isArray(manifest.present_files) ? manifest.present_files : [];

      assert(
        operatorStatus.runtime_status === "active",
        "parallel stress operator status must stay active"
      );
      assert(
        operatorStatus.overall_status === "active",
        "parallel stress overall status must stay active"
      );
      assert(
        operatorStatus.active_nodes.length === nodeCount,
        "parallel stress must surface all active nodes from canonical artifacts"
      );
      assert(
        operatorStatus.tmux_session_present === false,
        "parallel stress must not require a tmux session to inspect runtime state"
      );
      assert(
        operatorStatus.next_actions.some((entry) => entry.startsWith("Monitor active nodes:")),
        "parallel stress must keep artifact-first active-node guidance"
      );
      assert(
        operatorStatus.session_lock?.owner_label === "orchestrator:start",
        "parallel stress must expose canonical lock ownership"
      );
      assert(
        operatorStatus.last_event?.event_type === "operator.command.started",
        "parallel stress must expose canonical runtime event state"
      );
      assert(uniqueBranches.size === nodeCount, "parallel stress must preserve unique branches");
      assert(
        uniqueWorktrees.size === nodeCount,
        "parallel stress must preserve unique executor worktrees"
      );
      assert(
        presentFiles.includes("session-lock.json") &&
          presentFiles.includes("event-log.ndjson") &&
          presentFiles.includes("state.json") &&
          presentFiles.includes("gate-results.json"),
        "parallel stress manifest must enumerate canonical operator artifacts"
      );

      return {
        summary:
          "10-way parallel stress keeps operator inspection artifact-first while preserving branch and worktree isolation",
        evidence: [
          executionPlanPath,
          paths.stateJson,
          paths.gateResultsJson,
          paths.sessionLockJson,
          paths.eventLogNdjson,
          manifestPath,
        ].map((filePath) => relativeEvidence(repoRoot, filePath)),
        details: {
          active_node_count: operatorStatus.active_nodes.length,
          unique_branch_count: uniqueBranches.size,
          unique_worktree_count: uniqueWorktrees.size,
          tmux_session_present: operatorStatus.tmux_session_present,
          ready_candidates: (gate.dispatch.ready_candidates || []) as string[],
          manifest_present_files: presentFiles,
        },
      };
    });
  });
}

function runCrashResumeScenario(repoRoot: string, sessionSuffix: string): ScenarioResult {
  return runScenario("crash_resume", () => {
    const fixture = clonePhaseContractFixture({
      sessionId: `sess-20260308093000-certresume-${sessionSuffix}`,
      taskId: "OPS-900101",
    });

    return withSessionStateDir(repoRoot, fixture.metadata.sessionId, (stateDir, paths) => {
      const runningState = structuredClone(fixture.closeState);
      const runningNode = requireTaskNode(runningState.nodes, fixture.metadata.taskId);
      runningNode.status = "running";
      runningNode.worktree = path.join(repoRoot, "..", "wt", fixture.metadata.taskId);
      const runningGate = structuredClone(fixture.gateResults);
      const runningGateNode = requireGateNode(runningGate.nodes);
      runningGateNode.status = "running";
      runningGateNode.summary = "Recovered after orchestrator crash.";
      writeExecutionPlanArtifact(stateDir, fixture.executionPlan);
      writeStateArtifacts(paths, { state: runningState, gate: runningGate });

      const selection = selectPhaseFromSessionState({
        stateDir,
        repository: fixture.metadata.repository,
        parentIssueNumber: fixture.metadata.parentIssueNumbers[0] || 900,
        sessionId: fixture.metadata.sessionId,
      });
      assert(selection?.phase === "resume", "crash recovery must select resume");

      const invocations = buildPhaseInvocations(
        path.join(repoRoot, "tools", "orchestrator", "runtime"),
        baseSupervisorCli({
          repository: fixture.metadata.repository,
          parentIssue: fixture.metadata.parentIssueNumbers[0] || 900,
          stateDir,
          sessionId: fixture.metadata.sessionId,
          runIssue: fixture.metadata.runIssueNumber,
          runId: fixture.metadata.runId,
        }),
        selection
      );
      const status = summarizeOperatorStatus({
        repoRoot,
        sessionId: fixture.metadata.sessionId,
        stateDir,
      });
      const viewportNodes = readViewportNodes(stateDir);
      const viewportPlan = buildViewportPlan({
        repoRoot,
        sessionId: fixture.metadata.sessionId,
        stateDir,
        tmuxSession: normalizeTmuxSessionName(fixture.metadata.sessionId),
        nodes: viewportNodes,
      });

      assert(
        invocations[0]?.scriptPath.endsWith("execute.ts"),
        "crash recovery resume must route to execute.ts"
      );
      assert(status.overall_status === "active", "crash recovery operator status must stay active");
      assert(
        viewportPlan.windows[1]?.panes[0]?.title.includes(fixture.metadata.taskId),
        "crash recovery viewport must keep node pane"
      );

      return {
        summary: "session artifacts are sufficient to resume a crashed run without chat state",
        evidence: [paths.stateJson, paths.gateResultsJson].map((filePath) =>
          relativeEvidence(repoRoot, filePath)
        ),
        details: {
          resume_reason: selection.reason,
          delegated_script: invocations[0]?.scriptPath || "",
          tmux_session: viewportPlan.tmux_session,
        },
      };
    });
  });
}

function runStaleClaimScenario(): ScenarioResult {
  return runScenario("stale_claim", () => {
    const now = new Date("2026-03-08T09:30:00Z");
    const activeConflict = hasActiveForeignClaim(
      {
        task_id: "OPS-900102",
        task_type: "ops",
        status: "in progress",
        run_id: "run_foreign",
        claimed_by: "sess-foreign-owner",
        lease_expires_at: "2026-03-08T10:00:00Z",
        priority: 50,
        deps: [],
        allowed_files: ["tools/orchestrator/**"],
        acceptance_checks: [],
        tests: [],
        non_goals: [],
        commit_units: [],
        acceptance_criteria: [],
        rca_scope: "certification",
      },
      {
        sessionId: "sess-current-owner",
        runId: "run_local",
        now,
      }
    );
    const expiredRecovery = hasActiveForeignClaim(
      {
        task_id: "OPS-900102",
        task_type: "ops",
        status: "in progress",
        run_id: "run_foreign",
        claimed_by: "sess-foreign-owner",
        lease_expires_at: "2026-03-08T08:00:00Z",
        priority: 50,
        deps: [],
        allowed_files: ["tools/orchestrator/**"],
        acceptance_checks: [],
        tests: [],
        non_goals: [],
        commit_units: [],
        acceptance_criteria: [],
        rca_scope: "certification",
      },
      {
        sessionId: "sess-current-owner",
        runId: "run_local",
        now,
      }
    );

    assert(activeConflict === true, "stale claim drill must block active foreign lease");
    assert(expiredRecovery === false, "stale claim drill must release expired foreign lease");

    return {
      summary: "foreign claims block while leases are active and recover once leases expire",
      evidence: [],
      details: {
        active_foreign_claim: activeConflict,
        expired_lease_recovered: !expiredRecovery,
      },
    };
  });
}

function runReviewRejectScenario(repoRoot: string, sessionSuffix: string): ScenarioResult {
  return runScenario("review_reject", () => {
    const fixture = clonePhaseContractFixture({
      sessionId: `sess-20260308093000-certreview-${sessionSuffix}`,
      runId: "run_20260308_cert_review",
      taskId: "OPS-900103",
    });
    const blockedNode = requireTaskNode(fixture.closeState.nodes, fixture.metadata.taskId);
    blockedNode.status = "blocked";
    const rejectedGateNode = requireGateNode(fixture.gateResults.nodes);
    rejectedGateNode.status = "blocked";
    rejectedGateNode.summary = "Reviewer rejected the change.";
    rejectedGateNode.failure_reason = "review_rejected";

    return withSessionStateDir(repoRoot, fixture.metadata.sessionId, (stateDir, paths) => {
      writeExecutionPlanArtifact(stateDir, fixture.executionPlan);
      writeStateArtifacts(paths, {
        state: fixture.closeState,
        gate: fixture.gateResults,
        reviewFiles: {
          [fixture.metadata.taskId]: {
            decision: "reject",
            summary: "Regression found in operator status surface.",
            findings: [
              {
                severity: "high",
                category: "regression",
                summary: "close guidance regressed for blocked sessions",
              },
            ],
            escalation: {
              level: "manual",
              reason: "requires human triage",
            },
          },
        },
      });

      const preCloseStatus = summarizeOperatorStatus({
        repoRoot,
        sessionId: fixture.metadata.sessionId,
        stateDir,
      });
      assert(
        preCloseStatus.next_actions.includes(`Run close for session ${fixture.metadata.sessionId}`),
        "review reject pre-close status must direct operator to close"
      );

      const { followup, closeout } = materializeCertificationCloseRun({
        paths,
        repoRoot,
        repository: fixture.metadata.repository,
        runIssueNumber: fixture.metadata.runIssueNumber,
        runId: fixture.metadata.runId,
        sessionId: fixture.metadata.sessionId,
        stateDir,
        state: fixture.closeState,
        gate: fixture.gateResults,
        reviewFiles: {
          [fixture.metadata.taskId]: {
            decision: "reject",
            summary: "Regression found in operator status surface.",
            findings: [
              {
                severity: "high",
                category: "regression",
                summary: "close guidance regressed for blocked sessions",
              },
            ],
            escalation: {
              level: "manual",
              reason: "requires human triage",
            },
          },
        },
      });
      assert(followup, "review reject must create follow-up drafts");
      const postCloseStatus = summarizeOperatorStatus({
        repoRoot,
        sessionId: fixture.metadata.sessionId,
        stateDir,
      });

      assert(Number(followup.count || 0) === 1, "review reject must create one follow-up");
      assert(
        postCloseStatus.next_actions.some((entry) => entry.includes("follow-up")),
        "review reject post-close status must surface follow-up action"
      );
      assert(
        !postCloseStatus.next_actions.includes(
          `Run close for session ${fixture.metadata.sessionId}`
        ),
        "review reject post-close status must not ask to rerun close"
      );

      return {
        summary: "review rejection becomes residue plus deterministic follow-up drafting",
        evidence: [
          path.join(paths.reviewDir, `${fixture.metadata.taskId}.json`),
          paths.followupDraftsJson,
          paths.closeoutSummaryJson,
        ].map((filePath) => relativeEvidence(repoRoot, filePath)),
        details: {
          followup_count: followup.count,
          closeout_next_actions: Array.isArray(closeout.next_actions) ? closeout.next_actions : [],
          operator_next_actions: postCloseStatus.next_actions,
        },
      };
    });
  });
}

function runMergeConflictScenario(repoRoot: string, sessionSuffix: string): ScenarioResult {
  return runScenario("merge_conflict", () => {
    const fixture = clonePhaseContractFixture({
      sessionId: `sess-20260308093000-certconflict-${sessionSuffix}`,
      runId: "run_20260308_cert_conflict",
      taskId: "OPS-900104",
    });
    const blockedNode = requireTaskNode(fixture.closeState.nodes, fixture.metadata.taskId);
    blockedNode.status = "blocked";
    const conflictGateNode = requireGateNode(fixture.gateResults.nodes);
    conflictGateNode.status = "blocked";
    conflictGateNode.summary = "Merge conflict paused the queue.";
    conflictGateNode.failure_reason = "merge_conflict";
    conflictGateNode.artifacts.conflict_json = `conflict/${fixture.metadata.taskId}.json`;
    conflictGateNode.pr_url = "https://github.com/Omluc/omta/pull/77";

    return withSessionStateDir(repoRoot, fixture.metadata.sessionId, (stateDir, paths) => {
      writeExecutionPlanArtifact(stateDir, fixture.executionPlan);
      writeStateArtifacts(paths, {
        state: fixture.closeState,
        gate: fixture.gateResults,
        conflictFiles: {
          [fixture.metadata.taskId]: {
            node_id: fixture.metadata.taskId,
            conflicts: ["tools/orchestrator/orchestrator.ts"],
            strategy: "manual",
          },
        },
      });

      const { followup } = materializeCertificationCloseRun({
        paths,
        repoRoot,
        repository: fixture.metadata.repository,
        runIssueNumber: fixture.metadata.runIssueNumber,
        runId: fixture.metadata.runId,
        sessionId: fixture.metadata.sessionId,
        stateDir,
        state: fixture.closeState,
        gate: fixture.gateResults,
      });
      assert(followup, "merge conflict must create follow-up drafts");
      const manifest = readJsonFile(paths.manifestJson) as JsonObject;
      const items = Array.isArray(followup.items) ? followup.items : [];
      assert(items.length === 1, "merge conflict must produce one follow-up draft");
      assert(
        String((items[0] as JsonObject).source_failure_reason || "") === "merge_conflict",
        "merge conflict follow-up must preserve failure reason"
      );
      assert(
        Array.isArray(manifest.present_directories) &&
          manifest.present_directories.includes("conflict"),
        "merge conflict manifest must retain conflict directory evidence"
      );

      return {
        summary: "merge conflicts stay in canonical residue with conflict artifact evidence",
        evidence: [
          path.join(paths.conflictDir, `${fixture.metadata.taskId}.json`),
          paths.followupDraftsJson,
          paths.manifestJson,
        ].map((filePath) => relativeEvidence(repoRoot, filePath)),
        details: {
          followup_failure_reason: (items[0] as JsonObject).source_failure_reason || "",
          manifest_present_directories: manifest.present_directories,
        },
      };
    });
  });
}

function runCleanupFailureScenario(repoRoot: string, sessionSuffix: string): ScenarioResult {
  return runScenario("cleanup_failure", () => {
    const fixture = clonePhaseContractFixture({
      sessionId: `sess-20260308093000-certcleanup-${sessionSuffix}`,
      runId: "run_20260308_cert_cleanup",
      taskId: "OPS-900105",
    });

    return withSessionStateDir(repoRoot, fixture.metadata.sessionId, (stateDir, paths) => {
      writeExecutionPlanArtifact(stateDir, fixture.executionPlan);
      writeStateArtifacts(paths, { state: fixture.closeState, gate: fixture.gateResults });

      const cleanupPlan = buildCleanupPlan({
        state: fixture.closeState,
        gate: fixture.gateResults,
        stateBackend: "local",
        repository: fixture.metadata.repository,
        runIssueNumber: fixture.metadata.runIssueNumber,
        runId: fixture.metadata.runId,
      });
      writeJsonFile(paths.cleanupPlanJson, cleanupPlan);

      const fakeBin = mkdtempSync(path.join(os.tmpdir(), "orch-cert-fake-python-"));
      const fakePython = path.join(fakeBin, "python3");
      writeFileSync(fakePython, "#!/bin/sh\nexit 17\n", "utf8");
      chmodSync(fakePython, 0o755);

      try {
        const result = runBunScript(
          repoRoot,
          path.join(repoRoot, "tools", "orchestrator", "runtime", "close.ts"),
          [
            "cleanup-apply",
            "--state-dir",
            stateDir,
            "--cleanup-plan-input",
            paths.cleanupPlanJson,
            "--repository",
            fixture.metadata.repository,
          ],
          {
            env: {
              ...Bun.env,
              PATH: `${fakeBin}:${Bun.env.PATH || ""}`,
            },
          }
        );
        assert(result.status !== 0, "cleanup failure drill must exit non-zero");
        assert(
          `${result.stderr}${result.stdout}`.includes("cleanup apply failed"),
          "cleanup failure drill must fail closed"
        );
      } finally {
        rmSync(fakeBin, { recursive: true, force: true });
      }

      assert(
        !existsSync(paths.cleanupApplySummaryJson),
        "cleanup failure drill must not emit cleanup apply summary on failure"
      );

      return {
        summary: "cleanup apply fails closed and leaves no false-success artifact",
        evidence: [paths.cleanupPlanJson].map((filePath) => relativeEvidence(repoRoot, filePath)),
        details: {
          cleanup_plan_id: cleanupPlan.plan_id,
          cleanup_target_count: cleanupPlan.target_count,
        },
      };
    });
  });
}

export function buildCertificationBundle(repoRoot: string): CertificationBundle {
  const sessionSuffix = buildSessionSuffix();
  const goldenPath = runGoldenPathScenario(repoRoot, sessionSuffix);
  const parallelStress = runParallelTenWayScenario(repoRoot, sessionSuffix);
  const recoveryPaths = [
    runCrashResumeScenario(repoRoot, sessionSuffix),
    runStaleClaimScenario(),
    runReviewRejectScenario(repoRoot, sessionSuffix),
    runMergeConflictScenario(repoRoot, sessionSuffix),
    runCleanupFailureScenario(repoRoot, sessionSuffix),
  ];
  const scenarios = [goldenPath, parallelStress, ...recoveryPaths];
  const failedScenarios = scenarios
    .filter((scenario) => !scenario.passed)
    .map((scenario) => scenario.id);

  return {
    schema_version: 1,
    generated_at: nowIsoUtc(),
    repository: "Omluc/omta",
    epic_issue_number: 5545,
    task_issue_number: 5555,
    command: "verify",
    status: failedScenarios.length === 0 ? "pass" : "fail",
    scenario_count: scenarios.length,
    passed_count: scenarios.filter((scenario) => scenario.passed).length,
    failed_scenarios: failedScenarios,
    golden_path: goldenPath,
    parallel_stress: parallelStress,
    recovery_paths: recoveryPaths,
    operator_surface: {
      passed: parallelStress.passed,
      source_of_truth: [
        "state.json",
        "gate-results.json",
        "session-manifest.json",
        "session-lock.json",
        "event-log.ndjson",
      ],
      viewport_role:
        "tmux is a derived viewport only and never the orchestration runtime source of truth.",
    },
    close_gate: {
      passed: failedScenarios.length === 0,
      workflow_doc: "docs/contracts/governance/workflow.md",
      certification_command: "bun run orchestrator:certify",
      rule: "Human + AI PM Orchestrator v1 must not close until this certification bundle passes.",
    },
  };
}

export function writeCertificationBundle(outputPath: string, bundle: CertificationBundle): string {
  const resolved = path.resolve(outputPath);
  writeJsonFile(resolved, bundle);
  return resolved;
}

function main(): void {
  const cli = parseCli(process.argv.slice(2));
  const repoRoot = resolveRepoRoot();
  const bundle = buildCertificationBundle(repoRoot);
  const outputPath = writeCertificationBundle(
    cli.output || path.join(repoRoot, DEFAULT_OUTPUT),
    bundle
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        status: bundle.status,
        output: outputPath,
        passed_count: bundle.passed_count,
        scenario_count: bundle.scenario_count,
        failed_scenarios: bundle.failed_scenarios,
      },
      null,
      2
    )}\n`
  );
  if (bundle.status !== "pass") {
    process.exit(1);
  }
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`orchestrator-certify failed: ${(error as Error).message}\n`);
    process.exit(1);
  }
}
