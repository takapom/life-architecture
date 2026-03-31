import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";

import {
  applyParentIssueReferenceForCommand,
  collectOpenIssueTargetsByTaskId,
  extractTaskIdFromIssueBody,
  parseUpsertItemsForCommand,
} from "./issue_runtime";

const scriptPath = path.resolve(import.meta.dir, "issue_runtime.ts");

function runCli(args: string[], payload: unknown) {
  return spawnSync("bun", [scriptPath, ...args], {
    cwd: import.meta.dir,
    encoding: "utf8",
    env: process.env,
    input: `${JSON.stringify(payload)}\n`,
  });
}

function buildTaskIssuePayload(taskId: string, title = "[TASK] sample task") {
  return {
    title,
    body: ["## Summary", "Sample", "", "## Task ID", taskId, "", "## Task Type", "ops"].join("\n"),
    labels: ["task"],
  };
}

test("extractTaskIdFromIssueBody reads Task ID section", () => {
  const body = [
    "## Summary",
    "Sample",
    "",
    "## Task ID",
    "OPS-260216902",
    "",
    "## Task Type",
    "ops",
  ].join("\n");

  expect(extractTaskIdFromIssueBody(body)).toBe("OPS-260216902");
});

test("extractTaskIdFromIssueBody reads inline Task ID token", () => {
  const body = ["## Summary", "Sample", "", "Task ID: OPS-260216914", ""].join("\n");
  expect(extractTaskIdFromIssueBody(body)).toBe("OPS-260216914");
});

test("collectOpenIssueTargetsByTaskId groups issues by task_id", () => {
  const matches = collectOpenIssueTargetsByTaskId("OPS-260216902", [
    {
      number: 100,
      title: "OPS-260216902: one",
      url: "https://github.com/owner/repo/issues/100",
      state: "OPEN",
      body: "## Summary\nsample\n",
    },
    {
      number: 101,
      title: "OPS-260216903: two",
      url: "https://github.com/owner/repo/issues/101",
      state: "OPEN",
      body: "## Summary\nsample\n",
    },
    {
      number: 102,
      title: "OPS-260216902: duplicate",
      url: "https://github.com/owner/repo/issues/102",
      state: "OPEN",
      body: "## Summary\nsample\n",
    },
  ]);

  expect(matches.map((entry) => entry.number)).toEqual([100, 102]);
});

test("collectOpenIssueTargetsByTaskId ignores closed issues", () => {
  const matches = collectOpenIssueTargetsByTaskId("OPS-260216904", [
    {
      number: 200,
      title: "OPS-260216904: open",
      url: "https://github.com/owner/repo/issues/200",
      state: "OPEN",
      body: "## Summary\nopen\n",
    },
    {
      number: 201,
      title: "OPS-260216904: closed",
      url: "https://github.com/owner/repo/issues/201",
      state: "CLOSED",
      body: "## Summary\nclosed\n",
    },
  ]);

  expect(matches.map((entry) => entry.number)).toEqual([200]);
});

test("parseUpsertItemsForCommand rejects unsupported command", () => {
  const payload = { items: [] };
  expect(() => parseUpsertItemsForCommand(payload, "upsert-task-issue")).toThrow(
    "unsupported upsert command"
  );
});

test("parseUpsertItemsForCommand requires root items array payload", () => {
  const payload = [buildTaskIssuePayload("OPS-260216906", "[TASK] one")];
  expect(() => parseUpsertItemsForCommand(payload, "upsert-task-issues")).toThrow(
    "upsert must be a JSON object"
  );
});

test("parseUpsertItemsForCommand requires explicit task_id", () => {
  const payload = {
    items: [
      {
        issue: buildTaskIssuePayload("OPS-260216907", "[TASK] missing explicit task_id"),
      },
    ],
  };
  expect(() => parseUpsertItemsForCommand(payload, "upsert-task-issues")).toThrow(
    "task_id is required"
  );
});

test("parseUpsertItemsForCommand rejects taskId alias", () => {
  const payload = {
    items: [
      {
        issue: buildTaskIssuePayload("OPS-260216908", "[TASK] taskId alias"),
        taskId: "OPS-260216908",
      },
    ],
  };
  expect(() => parseUpsertItemsForCommand(payload, "upsert-task-issues")).toThrow(
    "taskId is unsupported"
  );
});

test("parseUpsertItemsForCommand rejects parent metadata in payload", () => {
  const payload = {
    items: [
      {
        issue: buildTaskIssuePayload("OPS-260216910", "[TASK] parent in payload"),
        task_id: "OPS-260216910",
        parent_issue_number: 808,
      },
    ],
  };
  expect(() => parseUpsertItemsForCommand(payload, "upsert-task-issues")).toThrow(
    "parent_issue_number is unsupported"
  );
});

test("parseUpsertItemsForCommand rejects unknown item keys", () => {
  const payload = {
    items: [
      {
        issue: buildTaskIssuePayload("OPS-260216910", "[TASK] unknown field"),
        task_id: "OPS-260216910",
        foo: "bar",
      },
    ],
  };
  expect(() => parseUpsertItemsForCommand(payload, "upsert-task-issues")).toThrow(
    ".foo is unsupported"
  );
});

test("parseUpsertItemsForCommand accepts canonical payload shape only", () => {
  const payload = {
    items: [
      {
        issue: buildTaskIssuePayload("OPS-260216911", "[TASK] canonical payload"),
        task_id: "OPS-260216911",
        issue_number: 42,
      },
    ],
  };
  const parsed = parseUpsertItemsForCommand(payload, "upsert-task-issues") as unknown as Array<
    Record<string, unknown>
  >;
  expect(parsed[0]?.taskIdHint).toBe("OPS-260216911");
  expect(parsed[0]?.issueNumber).toBe(42);
});

test("parseUpsertItemsForCommand rejects duplicate task_id", () => {
  const payload = {
    items: [
      {
        issue: buildTaskIssuePayload("OPS-260216912", "[TASK] duplicate one"),
        task_id: "OPS-260216912",
      },
      {
        issue: buildTaskIssuePayload("OPS-260216912", "[TASK] duplicate two"),
        task_id: "OPS-260216912",
      },
    ],
  };
  expect(() => parseUpsertItemsForCommand(payload, "upsert-task-issues")).toThrow(
    "duplicate task_id"
  );
});

test("applyParentIssueReferenceForCommand leaves standalone task issue unlinked when parent is omitted", () => {
  const payload = {
    items: [
      {
        issue: buildTaskIssuePayload("OPS-260216920", "[TASK] missing parent"),
        task_id: "OPS-260216920",
      },
    ],
  };
  const parsed = parseUpsertItemsForCommand(payload, "upsert-task-issues");
  const applied = applyParentIssueReferenceForCommand(parsed) as unknown as Array<
    Record<string, unknown>
  >;
  expect(applied[0]?.parentIssueNumber).toBe(0);
});

test("applyParentIssueReferenceForCommand applies parent from flag", () => {
  const payload = {
    items: [
      {
        issue: buildTaskIssuePayload("OPS-260216921", "[TASK] parent from flag"),
        task_id: "OPS-260216921",
      },
    ],
  };
  const parsed = parseUpsertItemsForCommand(payload, "upsert-task-issues");
  const applied = applyParentIssueReferenceForCommand(parsed, 808) as unknown as Array<
    Record<string, unknown>
  >;
  expect(applied[0]?.parentIssueNumber).toBe(808);
});

test("issue_runtime rejects multi-item upsert without parent-issue", () => {
  const payload = {
    items: [
      {
        issue: buildTaskIssuePayload("OPS-260216930", "[TASK] first"),
        task_id: "OPS-260216930",
      },
      {
        issue: buildTaskIssuePayload("OPS-260216931", "[TASK] second"),
        task_id: "OPS-260216931",
      },
    ],
  };
  const run = runCli(["upsert-task-issues", "--repository", "owner/repo", "--dry-run"], payload);
  expect(run.status).toBe(1);
  expect(`${run.stderr}`).toContain(
    "--parent-issue is required when upserting multiple task issues"
  );
});
