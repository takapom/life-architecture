import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { validateHandoff } from "./register_runtime";

const scriptPath = path.resolve(import.meta.dir, "register_runtime.ts");

function runCli(args: string[]) {
  return spawnSync("bun", [scriptPath, ...args], {
    cwd: import.meta.dir,
    encoding: "utf8",
    env: process.env,
  });
}
function sampleHandoffPayload(): Record<string, unknown> {
  return {
    issue_tracking: {
      strategy: "remote-github-sot",
      repository: "Omluc/omta",
      progress_issue_number: 800000,
      progress_issue_url: "https://github.com/Omluc/omta/issues/800000",
    },
    source_items: [
      {
        id: "FC-1",
        verdict: "valid",
        summary: "first",
        parent_issue_number: 900,
        parent_issue_url: "https://github.com/Omluc/omta/issues/900",
      },
      {
        id: "FC-2",
        verdict: "pending",
        summary: "second",
        parent_issue_number: 900,
        parent_issue_url: "https://github.com/Omluc/omta/issues/900",
      },
    ],
    issue_map: {
      "FC-1": "https://github.com/Omluc/omta/issues/100",
      "FC-2": "https://github.com/Omluc/omta/issues/101",
    },
    nodes: [
      {
        id: "OPS-900001",
        branch: "task/ops-900001",
        allowed_files: ["scripts/check-docs.ts"],
        acceptance_checks: ["bun run check:docs"],
        tests: ["bun run check:docs"],
        github_issue: "https://github.com/Omluc/omta/issues/100",
        covers: ["FC-1"],
      },
    ],
  };
}

test("validateHandoff allows source items without parent issue contract", () => {
  const payload = sampleHandoffPayload();
  const source_items = [
    {
      id: "FC-1",
      verdict: "valid",
      summary: "first",
    },
    {
      id: "FC-2",
      verdict: "pending",
      summary: "second",
      parent_issue_number: 900,
      parent_issue_url: "https://github.com/Omluc/omta/issues/900",
    },
  ];
  const errors = validateHandoff({ ...payload, source_items });
  expect(errors.some((entry) => entry.includes("parent_issue"))).toBe(false);
});

test("validateHandoff rejects incomplete parent issue contract", () => {
  const payload = sampleHandoffPayload();
  const source_items = [
    {
      id: "FC-1",
      verdict: "valid",
      summary: "first",
      parent_issue_number: 900,
    },
    {
      id: "FC-2",
      verdict: "pending",
      summary: "second",
      parent_issue_number: 900,
      parent_issue_url: "https://github.com/Omluc/omta/issues/900",
    },
  ];
  const errors = validateHandoff({ ...payload, source_items });
  expect(
    errors.some((entry) =>
      entry.includes("must set parent_issue_number and parent_issue_url together")
    )
  ).toBe(true);
});

test("validateHandoff rejects empty parent issue metadata values when keys are present", () => {
  const payload = sampleHandoffPayload();
  const source_items = [
    {
      id: "FC-1",
      verdict: "valid",
      summary: "first",
      parent_issue_number: 900,
      parent_issue_url: "",
    },
    {
      id: "FC-2",
      verdict: "pending",
      summary: "second",
      parent_issue_number: 900,
      parent_issue_url: "https://github.com/Omluc/omta/issues/900",
    },
  ];
  const errors = validateHandoff({ ...payload, source_items });
  expect(
    errors.some((entry) => entry.includes("source_items[0].parent_issue_url is required"))
  ).toBe(true);
});

test("validateHandoff enforces valid source item coverage", () => {
  const payload = sampleHandoffPayload();
  const nodes = (payload.nodes as Array<Record<string, unknown>>).map((node) => ({
    ...node,
    covers: [],
  }));
  const errors = validateHandoff({ ...payload, nodes });
  expect(errors.some((entry) => entry.includes("valid source item FC-1 must be covered"))).toBe(
    true
  );
});

test("validateHandoff rejects coverage of non-valid source items", () => {
  const payload = sampleHandoffPayload();
  const nodes = [
    {
      id: "OPS-900001",
      branch: "task/ops-900001",
      allowed_files: ["scripts/check-docs.ts"],
      acceptance_checks: ["bun run check:docs"],
      tests: ["bun run check:docs"],
      github_issue: "https://github.com/Omluc/omta/issues/100",
      covers: ["FC-1", "FC-2"],
    },
  ];
  const errors = validateHandoff({ ...payload, nodes });
  expect(
    errors.some((entry) => entry.includes("non-valid source item FC-2 must not be covered"))
  ).toBe(true);
});

test("validateHandoff rejects issue_map entries outside repository", () => {
  const payload = sampleHandoffPayload();
  const issue_map = {
    "FC-1": "https://github.com/other/repo/issues/999",
    "FC-2": "https://github.com/Omluc/omta/issues/101",
  };
  const errors = validateHandoff({ ...payload, issue_map });
  expect(
    errors.some((entry) => entry.includes("must reference https://github.com/Omluc/omta"))
  ).toBe(true);
});

test("validateHandoff accepts missing progress issue contract", () => {
  const payload = sampleHandoffPayload();
  const issue_tracking = {
    ...(payload.issue_tracking as Record<string, unknown>),
    progress_issue_number: 0,
    progress_issue_url: "",
  };
  const errors = validateHandoff({
    ...payload,
    issue_tracking,
  });
  expect(errors.some((entry) => entry.includes("issue_tracking.progress_issue_number"))).toBe(
    false
  );
  expect(errors.some((entry) => entry.includes("issue_tracking.progress_issue_url"))).toBe(false);
});

test("validateHandoff rejects duplicate issue_map URLs", () => {
  const payload = sampleHandoffPayload();
  const errors = validateHandoff({
    ...payload,
    issue_map: {
      "FC-1": "https://github.com/Omluc/omta/issues/100",
      "FC-2": "https://github.com/Omluc/omta/issues/100",
    },
  });
  expect(
    errors.some((entry) =>
      entry.includes("issue_map must not map multiple source ids to the same issue URL")
    )
  ).toBe(true);
});

test("validateHandoff rejects node missing github_issue", () => {
  const payload = sampleHandoffPayload();
  const nodes = [
    {
      ...(payload.nodes as Array<Record<string, unknown>>)[0],
      github_issue: "",
    },
  ];
  const errors = validateHandoff({ ...payload, nodes });
  expect(errors.some((entry) => entry.includes("github_issue is required"))).toBe(true);
});

test("validateHandoff rejects node github_issue mismatch against issue_map", () => {
  const payload = sampleHandoffPayload();
  const nodes = [
    {
      ...(payload.nodes as Array<Record<string, unknown>>)[0],
      github_issue: "https://github.com/Omluc/omta/issues/999",
    },
  ];
  const errors = validateHandoff({ ...payload, nodes });
  expect(errors.some((entry) => entry.includes("github_issue must match issue_map.FC-1"))).toBe(
    true
  );
});

test("validateHandoff rejects node with multi-source covers", () => {
  const payload = sampleHandoffPayload();
  const nodes = [
    {
      ...(payload.nodes as Array<Record<string, unknown>>)[0],
      covers: ["FC-1", "FC-2"],
    },
  ];
  const errors = validateHandoff({ ...payload, nodes });
  expect(errors.some((entry) => entry.includes("covers must contain exactly one source id"))).toBe(
    true
  );
});

test("register_runtime build requires --repository", () => {
  const run = runCli(["build"]);
  expect(run.status).toBe(1);
  expect(`${run.stderr}`).toContain("--repository is required and must be <owner>/<repo>");
});

test("register_runtime help uses execution-plan terminology in examples", () => {
  const run = runCli(["--help"]);
  expect(run.status).toBe(0);
  expect(`${run.stdout}`).toContain(".tmp/execution-plan.json");
  expect(`${run.stdout}`).not.toContain(".tmp/issue-dag.json");
});

test("register_runtime rejects unknown options", () => {
  const run = runCli(["build", "--repository", "owner/repo", "--unknown-flag", "value"]);
  expect(run.status).toBe(1);
  expect(`${run.stderr}`).toContain("unknown option: --unknown-flag");
});
