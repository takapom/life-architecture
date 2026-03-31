import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { TaskIssue } from "../../../../tools/core/issue-graph-types";
import {
  buildPhaseInvocations,
  parseIssueNumber,
  parseParentIssueNumber,
  resolveRequestedIssueScope,
  selectPhaseFromSessionState,
  selectPhaseFromTaskIssues,
} from "./supervisor_runtime";

const repoRoot = path.resolve(import.meta.dir, "../../../../");
const scriptPath = path.resolve(import.meta.dir, "supervisor_runtime.ts");
const skillRoot = path.resolve(import.meta.dir, "..");

function buildTaskIssue(overrides: Partial<TaskIssue> = {}): TaskIssue {
  return {
    id: "task-node-1",
    number: 101,
    title: "[TASK] Example",
    state: "open",
    htmlUrl: "https://github.com/owner/repo/issues/101",
    labels: ["task"],
    metadata: {
      task_id: "ARCH-2603082205",
      task_type: "feature",
      status: "backlog",
      run_id: "",
      claimed_by: "",
      lease_expires_at: "",
      priority: 10,
      deps: [],
      allowed_files: ["tools/orchestrator/**"],
      acceptance_checks: ["bun run test:kanban"],
      tests: ["bun test ./example.test.ts"],
      non_goals: [],
      commit_units: [],
      acceptance_criteria: [],
      rca_scope: "supervisor",
    },
    dependencySource: "none",
    graph: {
      blockedBy: [],
      parent: 900,
      subIssues: [],
    },
    ...overrides,
  };
}

test("supervisor_runtime help describes select-phase and run", () => {
  const run = spawnSync("bun", [scriptPath, "--help"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  expect(run.status).toBe(0);
  expect(`${run.stdout}`).toContain("select-phase");
  expect(`${run.stdout}`).toContain("run");
  expect(`${run.stdout}`).toContain("session artifacts first");
  expect(`${run.stdout}`).toContain("--issue");
});

test("parseParentIssueNumber accepts numbers and issue URLs", () => {
  expect(parseParentIssueNumber("900")).toBe(900);
  expect(parseParentIssueNumber("#900")).toBe(900);
  expect(parseParentIssueNumber("https://github.com/owner/repo/issues/900")).toBe(900);
});

test("parseIssueNumber accepts canonical issue selectors", () => {
  expect(parseIssueNumber("5633")).toBe(5633);
  expect(parseIssueNumber("#5633")).toBe(5633);
  expect(parseIssueNumber("https://github.com/owner/repo/issues/5633")).toBe(5633);
});

test("resolveRequestedIssueScope prefers task issue routing for canonical issue selectors", () => {
  expect(resolveRequestedIssueScope([buildTaskIssue()], 101)).toEqual({
    parentIssueNumber: 0,
    taskIssueNumber: 101,
  });
});

test("resolveRequestedIssueScope falls back to parent scope when selector is not a task issue", () => {
  expect(resolveRequestedIssueScope([buildTaskIssue()], 900)).toEqual({
    parentIssueNumber: 900,
    taskIssueNumber: 0,
  });
});

test("selectPhaseFromTaskIssues chooses intake when parent has no task issues", () => {
  const selection = selectPhaseFromTaskIssues({
    repository: "owner/repo",
    parentIssueNumber: 900,
    taskIssueNumber: 0,
    sessionId: "sess-20260308-abc12345",
    stateDir: "/tmp/sessions/sess-20260308-abc12345",
    intakeInput: "",
    taskIssues: [],
  });

  expect(selection.phase).toBe("intake");
  expect(selection.source).toBe("github");
  expect(selection.missing_inputs).toEqual(["intake-input"]);
});

test("selectPhaseFromTaskIssues chooses execute when parent has open task issues", () => {
  const selection = selectPhaseFromTaskIssues({
    repository: "owner/repo",
    parentIssueNumber: 900,
    taskIssueNumber: 0,
    sessionId: "sess-20260308-abc12345",
    stateDir: "/tmp/sessions/sess-20260308-abc12345",
    intakeInput: "",
    taskIssues: [buildTaskIssue()],
  });

  expect(selection.phase).toBe("execute");
  expect(selection.open_task_issue_count).toBe(1);
  expect(selection.missing_inputs).toEqual([]);
});

test("selectPhaseFromTaskIssues chooses close when parent tasks are already done but session state is missing", () => {
  const selection = selectPhaseFromTaskIssues({
    repository: "owner/repo",
    parentIssueNumber: 900,
    taskIssueNumber: 0,
    sessionId: "sess-20260308-abc12345",
    stateDir: "/tmp/sessions/sess-20260308-abc12345",
    intakeInput: "",
    taskIssues: [
      buildTaskIssue({
        state: "closed",
        metadata: {
          ...buildTaskIssue().metadata,
          status: "done",
        },
      }),
    ],
  });

  expect(selection.phase).toBe("close");
  expect(selection.missing_inputs).toEqual(["session-state"]);
});

test("selectPhaseFromTaskIssues routes standalone task issues directly", () => {
  const selection = selectPhaseFromTaskIssues({
    repository: "owner/repo",
    parentIssueNumber: 0,
    taskIssueNumber: 101,
    sessionId: "sess-20260308-abc12345",
    stateDir: "/tmp/sessions/sess-20260308-abc12345",
    intakeInput: "",
    taskIssues: [
      buildTaskIssue({
        graph: {
          blockedBy: [],
          parent: null,
          subIssues: [],
        },
      }),
    ],
  });

  expect(selection.phase).toBe("execute");
  expect(selection.parent_issue_number).toBe(0);
  expect(selection.task_issue_number).toBe(101);
  expect(selection.reason).toContain("task issue #101 is open");
});

test("selectPhaseFromSessionState chooses resume when non-terminal nodes remain", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "orch-supervisor-session-"));
  try {
    writeFileSync(
      path.join(tempRoot, "state.json"),
      `${JSON.stringify(
        {
          nodes: {
            "OPS-1": { status: "running" },
            "OPS-2": { status: "done" },
          },
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const selection = selectPhaseFromSessionState({
      stateDir: tempRoot,
      repository: "owner/repo",
      parentIssueNumber: 900,
      sessionId: "sess-20260308-abc12345",
    });

    expect(selection?.phase).toBe("resume");
    expect(selection?.source).toBe("session");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("selectPhaseFromSessionState chooses close when session is terminal", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "orch-supervisor-terminal-"));
  try {
    writeFileSync(
      path.join(tempRoot, "state.json"),
      `${JSON.stringify(
        {
          nodes: {
            "OPS-1": { status: "done" },
            "OPS-2": { status: "blocked" },
          },
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const selection = selectPhaseFromSessionState({
      stateDir: tempRoot,
      repository: "owner/repo",
      parentIssueNumber: 900,
      sessionId: "sess-20260308-abc12345",
    });

    expect(selection?.phase).toBe("close");
    expect(selection?.done_task_issue_count).toBe(2);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("buildPhaseInvocations routes intake to plan upsert and validate", () => {
  const invocations = buildPhaseInvocations(
    skillRoot,
    {
      command: "run",
      repository: "owner/repo",
      issue: "",
      parentIssue: "900",
      stateBackend: "github",
      stateDir: "",
      sessionId: "sess-20260308-abc12345",
      intakeInput: ".tmp/task-issues.json",
      taskSource: "",
      skillsConfig: "",
      profile: "",
      allowDirtyBase: false,
      runIssue: "",
      runId: "",
      baseBranch: "",
    },
    {
      phase: "intake",
      source: "github",
      reason: "parent issue has no linked task issues",
      repository: "owner/repo",
      parent_issue_number: 900,
      task_issue_number: 0,
      session_id: "sess-20260308-abc12345",
      state_dir: "",
      missing_inputs: [],
      task_issue_count: 0,
      open_task_issue_count: 0,
      done_task_issue_count: 0,
    }
  );

  expect(invocations).toHaveLength(2);
  expect(invocations[0]?.scriptPath).toContain("orchestrate-plan/scripts/plan_runtime.ts");
  expect(invocations[0]?.args[0]).toBe("intake-upsert");
  expect(invocations[1]?.args[0]).toBe("intake-validate");
});

test("buildPhaseInvocations routes resume to execute run with session-scoped args", () => {
  const invocations = buildPhaseInvocations(
    skillRoot,
    {
      command: "run",
      repository: "owner/repo",
      issue: "",
      parentIssue: "900",
      stateBackend: "github",
      stateDir: "/tmp/sessions/sess-20260308-abc12345",
      sessionId: "sess-20260308-abc12345",
      intakeInput: "",
      taskSource: ".tmp/issues.json",
      skillsConfig: ".tmp/skills.config.toml",
      profile: "remote-pr-default",
      allowDirtyBase: true,
      runIssue: "901",
      runId: "",
      baseBranch: "",
    },
    {
      phase: "resume",
      source: "session",
      reason: "session has 1 non-terminal node",
      repository: "owner/repo",
      parent_issue_number: 900,
      task_issue_number: 0,
      session_id: "sess-20260308-abc12345",
      state_dir: "/tmp/sessions/sess-20260308-abc12345",
      missing_inputs: [],
      task_issue_count: 0,
      open_task_issue_count: 0,
      done_task_issue_count: 0,
    }
  );

  expect(invocations).toHaveLength(1);
  expect(invocations[0]?.scriptPath).toContain("orchestrate-execute/scripts/execute_runtime.ts");
  expect(invocations[0]?.args).toContain("run");
  expect(invocations[0]?.args).toContain("--session-id");
  expect(invocations[0]?.args).toContain("sess-20260308-abc12345");
  expect(invocations[0]?.args).toContain("--allow-dirty-base");
});

test("selectPhaseFromSessionState fails closed when session artifacts are incomplete", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "orch-supervisor-broken-"));
  try {
    mkdirSync(path.join(tempRoot, "status"), { recursive: true });

    expect(() =>
      selectPhaseFromSessionState({
        stateDir: tempRoot,
        repository: "owner/repo",
        parentIssueNumber: 900,
        sessionId: "sess-20260308-abc12345",
      })
    ).toThrow("session artifacts exist but state.json is missing");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
