import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeGithubRunContextFile } from "../../../../tools/orchestrator/shared/github_run_context";
import {
  buildCleanupPlan,
  buildCleanupTargets,
  buildFollowupDrafts,
  buildGateFromGithubRunNodes,
  buildStateFromGithubRunNodes,
  extractResidueNodes,
  mapKanbanStatusToCloseStatus,
  normalizeKanbanStatus,
  parseCleanupPlan,
  resolveGithubRunContextForClose,
  resolveParentIssueSyncScopeFromRuntimeArtifacts,
  resolveStateBackend,
  shouldRunParentIssueSync,
  validateCloseState,
} from "./close_runtime";

const repoRoot = path.resolve(import.meta.dir, "../../../../");
const scriptPath = path.resolve(import.meta.dir, "close_runtime.ts");
const sessionRoot = path.resolve(repoRoot, "..", "wt", ".omta", "state", "sessions");

function makeCliStateDir(prefix: string): string {
  mkdirSync(sessionRoot, { recursive: true });
  return mkdtempSync(path.join(sessionRoot, prefix));
}

test("validateCloseState rejects non-terminal statuses", () => {
  const errors = validateCloseState(
    {
      updated_at: "2026-02-17T00:00:00Z",
      nodes: {
        "OPS-1": {
          status: "running",
          branch: "task/ops-1",
          worktree: "",
          attempts: 0,
          last_update: "2026-02-17T00:00:00Z",
        },
      },
    },
    {
      generated_at: "2026-02-17T00:00:00Z",
      state_updated_at: "2026-02-17T00:00:00Z",
      nodes: [
        {
          node_id: "OPS-1",
          status: "running",
          branch: "task/ops-1",
          summary: "",
          failure_reason: "",
          pr_url: "",
          artifacts: {},
        },
      ],
    }
  );

  expect(errors.some((entry) => entry.includes("non-terminal status"))).toBeTrue();
});

test("validateCloseState rejects ready_for_review for standard close flow", () => {
  const errors = validateCloseState(
    {
      updated_at: "2026-02-17T00:00:00Z",
      nodes: {
        "OPS-1": {
          status: "ready_for_review",
          branch: "task/ops-1",
          worktree: "",
          attempts: 0,
          last_update: "2026-02-17T00:00:00Z",
        },
      },
    },
    {
      generated_at: "2026-02-17T00:00:00Z",
      state_updated_at: "2026-02-17T00:00:00Z",
      nodes: [
        {
          node_id: "OPS-1",
          status: "ready_for_review",
          branch: "task/ops-1",
          summary: "",
          failure_reason: "",
          pr_url: "",
          artifacts: {},
        },
      ],
    }
  );

  expect(errors).toContain("node OPS-1: non-terminal status 'ready_for_review'");
});

test("extractResidueNodes returns only non-done nodes", () => {
  const residues = extractResidueNodes(
    {
      updated_at: "2026-02-17T00:00:00Z",
      nodes: {
        "OPS-1": {
          status: "done",
          branch: "task/ops-1",
          worktree: "",
          attempts: 0,
          last_update: "2026-02-17T00:00:00Z",
        },
        "OPS-2": {
          status: "failed",
          branch: "task/ops-2",
          worktree: "",
          attempts: 1,
          last_update: "2026-02-17T00:00:00Z",
        },
      },
    },
    {
      generated_at: "2026-02-17T00:00:00Z",
      state_updated_at: "2026-02-17T00:00:00Z",
      nodes: [
        {
          node_id: "OPS-1",
          status: "done",
          branch: "task/ops-1",
          summary: "ok",
          failure_reason: "",
          pr_url: "https://github.com/owner/repo/pull/1",
          artifacts: {},
        },
        {
          node_id: "OPS-2",
          status: "failed",
          branch: "task/ops-2",
          summary: "acceptance gate failed",
          failure_reason: "acceptance_gate_failed",
          pr_url: "",
          artifacts: {},
        },
      ],
    },
    {
      "OPS-2": {
        summary: "acceptance gate failed",
      },
    },
    {
      "OPS-2": {
        decision: "reject",
        summary: "review found a regression",
        findings: [
          {
            severity: "high",
            category: "regression",
            summary: "merge gate bypassed reviewer lane",
          },
        ],
        escalation: {
          level: "manual",
          reason: "needs manual intervention",
        },
      },
    }
  );

  expect(residues.length).toBe(1);
  expect(residues[0]?.node_id).toBe("OPS-2");
  expect(residues[0]?.failure_reason).toBe("acceptance_gate_failed");
  expect(residues[0]?.review_decision).toBe("reject");
  expect(residues[0]?.review_findings[0]?.category).toBe("regression");
});

test("buildFollowupDrafts keeps deterministic residue ordering", () => {
  const payload = buildFollowupDrafts([
    {
      node_id: "OPS-2",
      status: "failed",
      branch: "task/ops-2",
      summary: "failed",
      failure_reason: "gate_failed",
      pr_url: "",
      review_decision: "reject",
      review_summary: "review found a regression",
      review_findings: [
        {
          severity: "high",
          category: "regression",
          summary: "merge gate bypassed reviewer lane",
        },
      ],
      review_escalation: {
        level: "manual",
        reason: "needs manual intervention",
      },
    },
  ]);

  expect(payload.count).toBe(1);
  const items = payload.items as Array<{
    source_node_id: string;
    suggested_summary: string;
    review: { decision: string; escalation: { level: string } };
  }>;
  expect(items[0]?.source_node_id).toBe("OPS-2");
  expect(items[0]?.suggested_summary).toContain("OPS-2");
  expect(items[0]?.review.decision).toBe("reject");
  expect(items[0]?.review.escalation.level).toBe("manual");
});

test("resolveStateBackend defaults to github", () => {
  expect(resolveStateBackend("")).toBe("github");
});

test("resolveStateBackend accepts explicit local backend", () => {
  expect(resolveStateBackend("local")).toBe("local");
});

test("buildCleanupTargets keeps one target per PR deterministically", () => {
  const targets = buildCleanupTargets(
    {
      updated_at: "2026-02-18T00:00:00Z",
      nodes: {
        "OPS-2": {
          status: "done",
          branch: "task/ops-shared",
          worktree: "",
          attempts: 0,
          last_update: "2026-02-18T00:00:00Z",
        },
        "OPS-1": {
          status: "merged",
          branch: "task/ops-shared",
          worktree: "",
          attempts: 0,
          last_update: "2026-02-18T00:00:00Z",
        },
        "OPS-3": {
          status: "failed",
          branch: "task/ops-failed",
          worktree: "",
          attempts: 0,
          last_update: "2026-02-18T00:00:00Z",
        },
      },
    },
    {
      generated_at: "2026-02-18T00:00:00Z",
      state_updated_at: "2026-02-18T00:00:00Z",
      nodes: [
        {
          node_id: "OPS-1",
          status: "merged",
          branch: "task/ops-shared",
          summary: "",
          failure_reason: "",
          pr_url: "https://github.com/owner/repo/pull/42",
          artifacts: {},
        },
        {
          node_id: "OPS-2",
          status: "done",
          branch: "task/ops-shared",
          summary: "",
          failure_reason: "",
          pr_url: "https://github.com/owner/repo/pull/42",
          artifacts: {},
        },
      ],
    }
  );

  expect(targets).toHaveLength(1);
  expect(targets[0]?.task_id).toBe("OPS-1");
  expect(targets[0]?.pr).toBe("42");
});

test("buildCleanupTargets fails when merged node has invalid pr_url", () => {
  expect(() =>
    buildCleanupTargets(
      {
        updated_at: "2026-02-18T00:00:00Z",
        nodes: {
          "OPS-1": {
            status: "done",
            branch: "task/ops-1",
            worktree: "",
            attempts: 0,
            last_update: "2026-02-18T00:00:00Z",
          },
        },
      },
      {
        generated_at: "2026-02-18T00:00:00Z",
        state_updated_at: "2026-02-18T00:00:00Z",
        nodes: [
          {
            node_id: "OPS-1",
            status: "done",
            branch: "task/ops-1",
            summary: "",
            failure_reason: "",
            pr_url: "",
            artifacts: {},
          },
        ],
      }
    )
  ).toThrow("cleanup target requires valid pr_url");
});

test("buildCleanupPlan and parseCleanupPlan preserve plan contract", () => {
  const plan = buildCleanupPlan({
    state: {
      updated_at: "2026-02-18T00:00:00Z",
      nodes: {
        "OPS-1": {
          status: "done",
          branch: "task/ops-1",
          worktree: "",
          attempts: 0,
          last_update: "2026-02-18T00:00:00Z",
        },
      },
    },
    gate: {
      generated_at: "2026-02-18T00:00:00Z",
      state_updated_at: "2026-02-18T00:00:00Z",
      nodes: [
        {
          node_id: "OPS-1",
          status: "done",
          branch: "task/ops-1",
          summary: "",
          failure_reason: "",
          pr_url: "https://github.com/owner/repo/pull/101",
          artifacts: {},
        },
      ],
    },
    stateBackend: "github",
    repository: "owner/repo",
    runIssueNumber: 123,
    runId: "run_20260218",
  });

  expect(plan.cleanup_plan_version).toBe(1);
  expect(plan.plan_id.startsWith("cp_")).toBeTrue();
  expect(plan.target_count).toBe(1);
  expect(plan.targets[0]?.pr).toBe("101");

  const parsed = parseCleanupPlan(plan);
  expect(parsed.plan_id).toBe(plan.plan_id);
  expect(parsed.run_issue_number).toBe(123);
  expect(parsed.run_id).toBe("run_20260218");
});

test("parseCleanupPlan rejects invalid version", () => {
  expect(() =>
    parseCleanupPlan({
      cleanup_plan_version: 0,
      generated_at: "2026-02-18T00:00:00Z",
      plan_id: "cp_deadbeef",
      state_backend: "local",
      repository: "owner/repo",
      run_issue_number: 0,
      run_id: "",
      targets: [{ task_id: "OPS-1", pr: "101" }],
    })
  ).toThrow("cleanup plan cleanup_plan_version must be 1");
});

test("normalizeKanbanStatus accepts project status vocabulary", () => {
  expect(normalizeKanbanStatus("backlog")).toBe("backlog");
  expect(normalizeKanbanStatus("ready")).toBe("ready");
  expect(normalizeKanbanStatus("in progress")).toBe("in progress");
  expect(normalizeKanbanStatus("in review")).toBe("in review");
  expect(normalizeKanbanStatus("inprogress")).toBe("");
});

test("mapKanbanStatusToCloseStatus converts persisted status to close runtime status", () => {
  expect(mapKanbanStatusToCloseStatus("backlog")).toBe("pending");
  expect(mapKanbanStatusToCloseStatus("ready")).toBe("pending");
  expect(mapKanbanStatusToCloseStatus("in progress")).toBe("running");
  expect(mapKanbanStatusToCloseStatus("in review")).toBe("ready_for_review");
  expect(mapKanbanStatusToCloseStatus("done")).toBe("done");
});

test("buildStateFromGithubRunNodes keeps branch metadata from existing state", () => {
  const state = buildStateFromGithubRunNodes(
    [
      {
        task_id: "OPS-1",
        status: "in review",
        run_id: "run_1",
        pr_url: "https://github.com/owner/repo/pull/1",
        failure_reason: "",
        updated_at: "2026-02-20T00:00:00Z",
      },
    ],
    {
      updated_at: "2026-02-19T00:00:00Z",
      nodes: {
        "OPS-1": {
          status: "done",
          branch: "task/ops-1",
          worktree: "../wt/OPS-1",
          attempts: 2,
          last_update: "2026-02-19T00:00:00Z",
        },
      },
    }
  );

  expect(state.nodes["OPS-1"]?.status).toBe("ready_for_review");
  expect(state.nodes["OPS-1"]?.branch).toBe("task/ops-1");
  expect(state.nodes["OPS-1"]?.worktree).toBe("../wt/OPS-1");
  expect(state.nodes["OPS-1"]?.attempts).toBe(2);
});

test("buildGateFromGithubRunNodes maps gate node status deterministically", () => {
  const state = {
    updated_at: "2026-02-20T00:00:00Z",
    nodes: {
      "OPS-2": {
        status: "blocked",
        branch: "task/ops-2",
        worktree: "",
        attempts: 0,
        last_update: "2026-02-20T00:00:00Z",
      },
    },
  };
  const gate = buildGateFromGithubRunNodes(
    [
      {
        task_id: "OPS-2",
        status: "in progress",
        run_id: "run_2",
        pr_url: "",
        failure_reason: "acceptance_gate_failed",
        updated_at: "2026-02-20T00:00:00Z",
      },
    ],
    state,
    null
  );

  expect(gate.nodes).toHaveLength(1);
  expect(gate.nodes[0]?.node_id).toBe("OPS-2");
  expect(gate.nodes[0]?.status).toBe("blocked");
  expect(gate.nodes[0]?.branch).toBe("task/ops-2");
  expect(gate.nodes[0]?.failure_reason).toBe("acceptance_gate_failed");
});

test("shouldRunParentIssueSync returns true for github backend without skip", () => {
  expect(shouldRunParentIssueSync("github", false)).toBeTrue();
});

test("shouldRunParentIssueSync returns false when skip flag is set", () => {
  expect(shouldRunParentIssueSync("github", true)).toBeFalse();
});

test("shouldRunParentIssueSync returns false for local backend", () => {
  expect(shouldRunParentIssueSync("local", false)).toBeFalse();
});

test("shouldRunParentIssueSync returns false for local backend with skip", () => {
  expect(shouldRunParentIssueSync("local", true)).toBeFalse();
});

test("resolveParentIssueSyncScopeFromRuntimeArtifacts returns unique parent issues from execution plan", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "omta-close-runtime-"));

  try {
    const executionPlanPath = path.join(stateDir, "inputs", "execution-plan.json");
    mkdirSync(path.dirname(executionPlanPath), { recursive: true });
    writeFileSync(
      executionPlanPath,
      `${JSON.stringify(
        {
          issue_tracking: {
            repository: "owner/repo",
          },
          source_items: [
            {
              id: "FC-2",
              parent_issue_number: 901,
              parent_issue_url: "https://github.com/owner/repo/issues/901",
            },
            {
              id: "FC-1",
              parent_issue_number: 900,
              parent_issue_url: "https://github.com/owner/repo/issues/900",
            },
            {
              id: "FC-3",
              parent_issue_number: 901,
              parent_issue_url: "https://github.com/owner/repo/issues/901",
            },
          ],
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    expect(
      resolveParentIssueSyncScopeFromRuntimeArtifacts({
        stateDir,
        repository: "owner/repo",
      })
    ).toEqual({
      executionPlanPath,
      parentIssueNumbers: [900, 901],
    });
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("resolveParentIssueSyncScopeFromRuntimeArtifacts allows execution plans without parent issues", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "omta-close-runtime-"));

  try {
    const executionPlanPath = path.join(stateDir, "inputs", "execution-plan.json");
    mkdirSync(path.dirname(executionPlanPath), { recursive: true });
    writeFileSync(
      executionPlanPath,
      `${JSON.stringify(
        {
          issue_tracking: {
            repository: "owner/repo",
          },
          source_items: [
            {
              id: "FC-1",
            },
          ],
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    expect(
      resolveParentIssueSyncScopeFromRuntimeArtifacts({
        stateDir,
        repository: "owner/repo",
      })
    ).toEqual({
      executionPlanPath,
      parentIssueNumbers: [],
    });
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("resolveParentIssueSyncScopeFromRuntimeArtifacts fails when parent issue metadata is incomplete", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "omta-close-runtime-"));

  try {
    const executionPlanPath = path.join(stateDir, "inputs", "execution-plan.json");
    mkdirSync(path.dirname(executionPlanPath), { recursive: true });
    writeFileSync(
      executionPlanPath,
      `${JSON.stringify(
        {
          issue_tracking: {
            repository: "owner/repo",
          },
          source_items: [
            {
              id: "FC-1",
              parent_issue_number: 900,
            },
          ],
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    expect(() =>
      resolveParentIssueSyncScopeFromRuntimeArtifacts({
        stateDir,
        repository: "owner/repo",
      })
    ).toThrow(
      "inputs/execution-plan.json source_items[0] must set parent_issue_number and parent_issue_url together"
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("resolveParentIssueSyncScopeFromRuntimeArtifacts fails when execution plan is missing", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "omta-close-runtime-"));

  try {
    expect(() =>
      resolveParentIssueSyncScopeFromRuntimeArtifacts({
        stateDir,
        repository: "owner/repo",
      })
    ).toThrow(`required file not found: ${path.join(stateDir, "inputs", "execution-plan.json")}`);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("resolveParentIssueSyncScopeFromRuntimeArtifacts fails when parent issue URL is empty", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "omta-close-runtime-"));

  try {
    const executionPlanPath = path.join(stateDir, "inputs", "execution-plan.json");
    mkdirSync(path.dirname(executionPlanPath), { recursive: true });
    writeFileSync(
      executionPlanPath,
      `${JSON.stringify(
        {
          issue_tracking: {
            repository: "owner/repo",
          },
          source_items: [
            {
              id: "FC-1",
              parent_issue_number: 900,
              parent_issue_url: "",
            },
          ],
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    expect(() =>
      resolveParentIssueSyncScopeFromRuntimeArtifacts({
        stateDir,
        repository: "owner/repo",
      })
    ).toThrow("inputs/execution-plan.json source_items[0].parent_issue_url is required");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("resolveGithubRunContextForClose reads canonical run context artifact for github backend", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "omta-close-runtime-"));

  try {
    writeGithubRunContextFile({
      stateDir,
      context: {
        schema_version: 1,
        generated_at: "2026-03-08T00:00:00Z",
        repository: "owner/repo",
        state_backend: "github",
        run_id: "run_local",
        run_issue_number: 5547,
        run_issue_url: "https://github.com/owner/repo/issues/5547",
        project_number: 12,
      },
    });

    expect(
      resolveGithubRunContextForClose({
        cliRepository: "",
        cliRunId: "",
        cliRunIssue: "",
        stateBackend: "github",
        stateDir,
      })
    ).toEqual({
      repository: "owner/repo",
      runId: "run_local",
      runIssueNumber: 5547,
    });
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("resolveGithubRunContextForClose fails closed on repository mismatch", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "omta-close-runtime-"));

  try {
    writeGithubRunContextFile({
      stateDir,
      context: {
        schema_version: 1,
        generated_at: "2026-03-08T00:00:00Z",
        repository: "owner/repo",
        state_backend: "github",
        run_id: "run_local",
        run_issue_number: 5547,
        run_issue_url: "https://github.com/owner/repo/issues/5547",
        project_number: 12,
      },
    });

    expect(() =>
      resolveGithubRunContextForClose({
        cliRepository: "other/repo",
        cliRunId: "",
        cliRunIssue: "",
        stateBackend: "github",
        stateDir,
      })
    ).toThrow("github close repository mismatch");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("close_runtime verify emits closeout summary and session manifest", () => {
  const stateDir = makeCliStateDir("close-runtime-verify-");

  try {
    writeFileSync(
      path.join(stateDir, "state.json"),
      `${JSON.stringify(
        {
          updated_at: "2026-03-08T00:00:00Z",
          nodes: {
            "OPS-1": {
              status: "done",
              branch: "task/ops-1",
              worktree: "../wt/OPS-1",
              attempts: 1,
              last_update: "2026-03-08T00:00:00Z",
            },
          },
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    writeFileSync(
      path.join(stateDir, "gate-results.json"),
      `${JSON.stringify(
        {
          generated_at: "2026-03-08T00:00:00Z",
          state_updated_at: "2026-03-08T00:00:00Z",
          nodes: [
            {
              node_id: "OPS-1",
              status: "done",
              branch: "task/ops-1",
              summary: "merged cleanly",
              failure_reason: "",
              pr_url: "https://github.com/owner/repo/pull/1",
              artifacts: {},
            },
          ],
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const run = spawnSync(
      "bun",
      [
        scriptPath,
        "verify",
        "--state-backend",
        "local",
        "--state-dir",
        stateDir,
        "--repository",
        "owner/repo",
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    expect(run.status).toBe(0);

    const closeoutPath = path.join(stateDir, "closeout-summary.json");
    const manifestPath = path.join(stateDir, "session-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      command: string;
      session_id: string;
      repository: string;
      files: {
        closeout_summary_json: string;
      };
      present_files: string[];
    };

    expect(JSON.parse(readFileSync(closeoutPath, "utf8"))).toMatchObject({
      state_backend: "local",
      residue_count: 0,
    });
    expect(manifest.command).toBe("close:verify");
    expect(manifest.session_id).toBe(path.basename(stateDir));
    expect(manifest.repository).toBe("owner/repo");
    expect(manifest.files.closeout_summary_json).toBe("closeout-summary.json");
    expect(manifest.present_files).toContain("closeout-summary.json");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("close_runtime run emits followup drafts and manifest uses canonical artifact names", {
  timeout: 45000,
}, () => {
  const stateDir = makeCliStateDir("close-runtime-run-");

  try {
    writeFileSync(
      path.join(stateDir, "state.json"),
      `${JSON.stringify(
        {
          updated_at: "2026-03-08T00:00:00Z",
          nodes: {
            "OPS-2": {
              status: "failed",
              branch: "task/ops-2",
              worktree: "../wt/OPS-2",
              attempts: 2,
              last_update: "2026-03-08T00:00:00Z",
            },
          },
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    writeFileSync(
      path.join(stateDir, "gate-results.json"),
      `${JSON.stringify(
        {
          generated_at: "2026-03-08T00:00:00Z",
          state_updated_at: "2026-03-08T00:00:00Z",
          nodes: [
            {
              node_id: "OPS-2",
              status: "failed",
              branch: "task/ops-2",
              summary: "acceptance failed",
              failure_reason: "acceptance_gate_failed",
              pr_url: "",
              artifacts: {},
            },
          ],
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    mkdirSync(path.join(stateDir, "status"), { recursive: true });
    writeFileSync(
      path.join(stateDir, "status", "OPS-2.json"),
      `${JSON.stringify(
        {
          status: "failed",
          summary: "acceptance failed",
          failure_reason: "acceptance_gate_failed",
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    mkdirSync(path.join(stateDir, "review"), { recursive: true });
    writeFileSync(
      path.join(stateDir, "review", "OPS-2.json"),
      `${JSON.stringify(
        {
          decision: "reject",
          summary: "review found a regression",
          findings: [
            {
              severity: "high",
              category: "regression",
              summary: "merge gate bypassed reviewer lane",
            },
          ],
          escalation: {
            level: "manual",
            reason: "needs manual intervention",
          },
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const run = spawnSync(
      "bun",
      [
        scriptPath,
        "run",
        "--state-backend",
        "local",
        "--state-dir",
        stateDir,
        "--repository",
        "owner/repo",
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    expect(run.status).toBe(0);

    const followupPath = path.join(stateDir, "followup-drafts.json");
    const manifestPath = path.join(stateDir, "session-manifest.json");
    const followup = JSON.parse(readFileSync(followupPath, "utf8")) as {
      count: number;
      items: Array<{
        source_node_id: string;
        review: { decision: string; escalation: { level: string } };
      }>;
    };
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      command: string;
      files: {
        cleanup_plan_json: string;
        followup_drafts_json: string;
        closeout_summary_json: string;
      };
      present_files: string[];
    };

    expect(followup.count).toBe(1);
    expect(followup.items[0]?.source_node_id).toBe("OPS-2");
    expect(followup.items[0]?.review.decision).toBe("reject");
    expect(followup.items[0]?.review.escalation.level).toBe("manual");
    expect(manifest.command).toBe("close:run");
    expect(manifest.files.cleanup_plan_json).toBe("cleanup-plan.json");
    expect(manifest.files.followup_drafts_json).toBe("followup-drafts.json");
    expect(manifest.files.closeout_summary_json).toBe("closeout-summary.json");
    expect(manifest.present_files).toContain("cleanup-plan.json");
    expect(manifest.present_files).toContain("followup-drafts.json");
    expect(manifest.present_files).toContain("closeout-summary.json");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
