import { expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { clonePhaseContractFixture } from "../../../../tools/orchestrator/test-support/orchestration-phase-fixtures";
import {
  buildOrchestratorRuntimeEnv,
  resolveRuntimeStateDir,
} from "../../orchestrate-execute/scripts/execute_runtime";
import { validateHandoff } from "../../orchestrate-plan/scripts/register_runtime";
import {
  buildCleanupPlan,
  extractResidueNodes,
  resolveParentIssueSyncScopeFromRuntimeArtifacts,
  validateCloseState,
} from "./close_runtime";

const repoRoot = path.resolve(import.meta.dir, "../../../../");

function writeExecutionPlanArtifact(stateDir: string, payload: unknown): string {
  const executionPlanPath = path.join(stateDir, "inputs", "execution-plan.json");
  mkdirSync(path.dirname(executionPlanPath), { recursive: true });
  writeFileSync(executionPlanPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return executionPlanPath;
}

test("phase contract fixture composes intake, execute, and close success path", () => {
  const fixture = clonePhaseContractFixture({
    sessionId: "sess-20260307155904-phaseok1",
    runId: "run_20260307_phase_ok",
    runIssueNumber: 4900,
  });
  const stateDir = resolveRuntimeStateDir(repoRoot, "", fixture.metadata.sessionId);

  try {
    expect(validateHandoff(fixture.executionPlan)).toEqual([]);

    const executionPlanPath = writeExecutionPlanArtifact(stateDir, fixture.executionPlan);
    const env = buildOrchestratorRuntimeEnv(
      repoRoot,
      {
        ...process.env,
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

    expect(existsSync(executionPlanPath)).toBeTrue();
    expect(env.ORCHESTRATE_SESSION_ID).toBe(fixture.metadata.sessionId);
    expect(existsSync(String(env.TMPDIR))).toBeTrue();
    expect(validateCloseState(fixture.closeState, fixture.gateResults)).toEqual([]);
    expect(extractResidueNodes(fixture.closeState, fixture.gateResults, {})).toEqual([]);
    expect(
      resolveParentIssueSyncScopeFromRuntimeArtifacts({
        stateDir,
        repository: fixture.metadata.repository,
      })
    ).toEqual({
      executionPlanPath,
      parentIssueNumbers: fixture.metadata.parentIssueNumbers,
    });

    const cleanupPlan = buildCleanupPlan({
      state: fixture.closeState,
      gate: fixture.gateResults,
      stateBackend: "github",
      repository: fixture.metadata.repository,
      runIssueNumber: fixture.metadata.runIssueNumber,
      runId: fixture.metadata.runId,
    });

    expect(cleanupPlan.target_count).toBe(1);
    expect(cleanupPlan.targets).toEqual([{ task_id: fixture.metadata.taskId, pr: "42" }]);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("phase contract fails closed when issue_map reuses the same GitHub issue", () => {
  const fixture = clonePhaseContractFixture();
  fixture.executionPlan.issue_map["FC-2"] = fixture.executionPlan.issue_map["FC-1"] || "";

  const errors = validateHandoff(fixture.executionPlan);

  expect(
    errors.some((entry) =>
      entry.includes("issue_map must not map multiple source ids to the same issue URL")
    )
  ).toBeTrue();
});

test("phase contract fails closed when close input loses parent issue metadata", () => {
  const fixture = clonePhaseContractFixture({
    sessionId: "sess-20260307155904-phasebad1",
  });
  const firstSourceItem = fixture.executionPlan.source_items[0];
  if (!firstSourceItem) {
    throw new Error("phase contract fixture must include at least one source item");
  }
  Reflect.deleteProperty(firstSourceItem, "parent_issue_url");
  const stateDir = resolveRuntimeStateDir(repoRoot, "", fixture.metadata.sessionId);

  try {
    writeExecutionPlanArtifact(stateDir, fixture.executionPlan);

    expect(() =>
      resolveParentIssueSyncScopeFromRuntimeArtifacts({
        stateDir,
        repository: fixture.metadata.repository,
      })
    ).toThrow(
      "inputs/execution-plan.json source_items[0] must set parent_issue_number and parent_issue_url together"
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("phase contract fails closed when close verification sees a non-terminal node", () => {
  const fixture = clonePhaseContractFixture();
  const taskNode = fixture.closeState.nodes[fixture.metadata.taskId];
  const firstGateNode = fixture.gateResults.nodes[0];
  if (!taskNode || !firstGateNode) {
    throw new Error("phase contract fixture must include close and gate nodes");
  }
  taskNode.status = "running";
  firstGateNode.status = "running";

  const errors = validateCloseState(fixture.closeState, fixture.gateResults);

  expect(errors.some((entry) => entry.includes("non-terminal status"))).toBeTrue();
});
