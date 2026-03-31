import { readFileSync } from "node:fs";
import path from "node:path";
import {
  buildExecutionPlanTaskScope,
  type ExecutionPlan,
} from "../runtime/execution-plan-contract";

export type ExecutionPlanFixture = ExecutionPlan;

export type CloseStateFixture = {
  updated_at: string;
  nodes: Record<
    string,
    {
      status: string;
      branch: string;
      worktree: string;
      attempts: number;
      last_update: string;
    }
  >;
};

export type GateResultsFixture = {
  generated_at: string;
  state_updated_at: string;
  dispatch: {
    review_policy: {
      mode: "auto" | "manual";
      auto_approve: boolean;
    };
  };
  nodes: Array<{
    node_id: string;
    status: string;
    branch: string;
    summary: string;
    failure_reason: string;
    pr_url: string;
    artifacts: {
      status_json?: string;
      conflict_json?: string;
      review_json?: string;
    };
  }>;
};

export type PhaseContractFixture = {
  executionPlan: ExecutionPlanFixture;
  closeState: CloseStateFixture;
  gateResults: GateResultsFixture;
  metadata: {
    repository: string;
    sessionId: string;
    runId: string;
    runIssueNumber: number;
    taskId: string;
    branch: string;
    parentIssueNumbers: number[];
    prUrl: string;
  };
};

type FixtureOptions = {
  sessionId?: string;
  runId?: string;
  runIssueNumber?: number;
  taskId?: string;
};

const EXECUTION_PLAN_FIXTURE_PATH = path.resolve(
  import.meta.dir,
  "../../contracts/fixtures/execution-plan.valid.json"
);

function loadExecutionPlanFixture(): ExecutionPlanFixture {
  return JSON.parse(readFileSync(EXECUTION_PLAN_FIXTURE_PATH, "utf8")) as ExecutionPlanFixture;
}

export function createPhaseContractFixture(options: FixtureOptions = {}): PhaseContractFixture {
  const executionPlan = loadExecutionPlanFixture();
  const repository = executionPlan.issue_tracking.repository;
  const taskId = options.taskId || executionPlan.nodes[0]?.id || "OPS-900001";
  const branch = `task/${taskId.toLowerCase()}-phase-contracts`;
  const sessionId = options.sessionId || "sess-20260307155904-phaseok1";
  const runId = options.runId || "run_20260307_phase_ok";
  const runIssueNumber = options.runIssueNumber ?? 4900;
  const prUrl = "https://github.com/Omluc/omta/pull/42";
  const taskNode = executionPlan.nodes[0];
  if (!taskNode) {
    throw new Error("execution plan fixture must include at least one node");
  }

  taskNode.id = taskId;
  taskNode.branch = branch;
  taskNode.commit_units =
    taskNode.commit_units && taskNode.commit_units.length > 0
      ? taskNode.commit_units
      : ["CU1: phase contract runtime"];
  taskNode.task_scope = buildExecutionPlanTaskScope(taskNode.allowed_files, taskNode.commit_units);

  return {
    executionPlan,
    closeState: {
      updated_at: "2026-03-07T07:00:00Z",
      nodes: {
        [taskId]: {
          status: "done",
          branch,
          worktree: `../wt/${taskId}`,
          attempts: 1,
          last_update: "2026-03-07T07:00:00Z",
        },
      },
    },
    gateResults: {
      generated_at: "2026-03-07T07:00:00Z",
      state_updated_at: "2026-03-07T07:00:00Z",
      dispatch: {
        review_policy: {
          mode: "auto",
          auto_approve: true,
        },
      },
      nodes: [
        {
          node_id: taskId,
          status: "done",
          branch,
          summary: "Cross-phase contract succeeded.",
          failure_reason: "",
          pr_url: prUrl,
          artifacts: {},
        },
      ],
    },
    metadata: {
      repository,
      sessionId,
      runId,
      runIssueNumber,
      taskId,
      branch,
      parentIssueNumbers: executionPlan.source_items
        .map((item) => Number(item.parent_issue_number || 0))
        .filter((value) => Number.isInteger(value) && value > 0),
      prUrl,
    },
  };
}

export function clonePhaseContractFixture(options: FixtureOptions = {}): PhaseContractFixture {
  return structuredClone(createPhaseContractFixture(options));
}
