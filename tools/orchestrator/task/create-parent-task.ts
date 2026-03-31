#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Command } from "commander";

import {
  fail,
  parseJson,
  resolveRepoRoot,
  writeOutput as writeOutputFile,
} from "../../adapters/cli";

type Cli = {
  repository: string;
  taskInputPath: string;
  parentTitle: string;
  parentBody: string;
  parentLabels: string[];
  dryRun: boolean;
  outputPath: string;
};

type CreateTaskPayload = {
  generated_at?: string;
  dry_run?: boolean;
  repository?: string;
  parent_issue?: string;
  parent_issue_plan?: {
    action?: string;
    title?: string;
    labels?: string[];
    body_preview?: string;
  };
  created_parent_issue?: {
    issue_number?: number;
    issue_url?: string;
    title?: string;
    labels?: string[];
  };
  issue_number?: number;
  issue_url?: string;
  task_id?: string;
  action?: string;
  issue_plan?: unknown;
};

function resolveBody(body: string, bodyFile: string): string {
  const inline = String(body || "").trim();
  const filePath = String(bodyFile || "").trim();
  if (inline && filePath) {
    fail("use either --parent-body or --parent-body-file, not both");
  }
  if (inline) return inline;
  if (filePath) {
    return readFileSync(path.resolve(filePath), "utf8").trim();
  }
  fail("--parent-body or --parent-body-file is required");
}

function collectLabels(value: string, previous: string[]): string[] {
  const normalized = String(value || "").trim();
  if (!normalized) return previous;
  return [...previous, normalized];
}

function parseCli(argv: string[]): Cli {
  const program = new Command()
    .name("create-parent-task")
    .description(
      "Explicit grouped-decomposition wrapper only; standalone creation and existing-issue reuse belong to create-task"
    )
    .requiredOption("--repository <owner/repo>", "Target repository")
    .requiredOption("--input <path>", "Task spec JSON path passed through to create-task")
    .requiredOption("--parent-title <title>", "Parent issue title")
    .option("--parent-body <text>", "Parent issue body")
    .option("--parent-body-file <path>", "Parent issue body file")
    .option(
      "--parent-label <label>",
      "Parent issue label (repeatable)",
      collectLabels,
      [] as string[]
    )
    .option(
      "--dry-run",
      "Validate input and print the planned actions without creating issues",
      false
    )
    .option("--output <path>", "Output JSON path")
    .addHelpText(
      "after",
      [
        "",
        "This wrapper is only for explicit grouped decomposition.",
        "Use create-task --standalone for a new standalone task issue.",
        "Use create-task --issue-number <n> when an existing issue already tracks the implementation unit.",
      ].join("\n")
    )
    .parse(["node", "create-parent-task", ...argv]);

  const opts = program.opts<{
    repository: string;
    input: string;
    parentTitle: string;
    parentBody?: string;
    parentBodyFile?: string;
    parentLabel: string[];
    dryRun: boolean;
    output?: string;
  }>();

  const [owner] = opts.repository.split("/");
  if (!owner || !opts.repository.includes("/")) {
    fail("--repository must be in <owner>/<repo> format");
  }

  return {
    repository: opts.repository,
    taskInputPath: path.resolve(opts.input),
    parentTitle: String(opts.parentTitle || "").trim(),
    parentBody: resolveBody(String(opts.parentBody || ""), String(opts.parentBodyFile || "")),
    parentLabels: [
      ...new Set((opts.parentLabel || []).map((label) => label.trim()).filter(Boolean)),
    ],
    dryRun: opts.dryRun,
    outputPath: String(opts.output || "").trim(),
  };
}

function runCreateTask(cli: Cli): CreateTaskPayload {
  const createTaskScript = path.join(
    resolveRepoRoot(),
    "tools",
    "orchestrator",
    "task",
    "create-task.ts"
  );
  const args = [
    createTaskScript,
    "--repository",
    cli.repository,
    "--input",
    cli.taskInputPath,
    "--parent-title",
    cli.parentTitle,
    "--parent-body",
    cli.parentBody,
  ];
  for (const label of cli.parentLabels) {
    args.push("--parent-label", label);
  }
  if (cli.dryRun) {
    args.push("--dry-run");
  }

  const result = spawnSync(Bun.env.OMTA_BUN_BIN || "bun", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: Bun.env,
  });
  if (result.status !== 0) {
    const detail = `${result.stderr || ""}\n${result.stdout || ""}`.trim();
    fail(
      `${path.basename(createTaskScript)} ${args.slice(1).join(" ")} failed: ${detail || `exit=${result.status}`}`
    );
  }
  return parseJson(String(result.stdout || "{}"), "create-task output") as CreateTaskPayload;
}

function parseIssueNumberFromUrl(url: string): number {
  const matched = String(url || "")
    .trim()
    .match(/\/issues\/(\d+)(?:[/?#].*)?$/i);
  return matched ? Number(matched[1] || 0) : 0;
}

function writeOutput(outputPath: string, payload: unknown): void {
  if (!outputPath) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  writeOutputFile(outputPath, payload);
}

async function main(): Promise<void> {
  await Promise.resolve();
  const cli = parseCli(process.argv.slice(2));
  const payload = runCreateTask(cli);

  if (cli.dryRun) {
    writeOutput(cli.outputPath, {
      generated_at: String(
        payload.generated_at || new Date().toISOString().replace(/\.\d{3}Z$/, "Z")
      ),
      dry_run: true,
      repository: cli.repository,
      parent_issue: {
        title: String(payload.parent_issue_plan?.title || cli.parentTitle),
        labels: Array.isArray(payload.parent_issue_plan?.labels)
          ? payload.parent_issue_plan?.labels
          : cli.parentLabels,
        body_preview: String(payload.parent_issue_plan?.body_preview || cli.parentBody),
      },
      issue_plan: payload.issue_plan || null,
    });
    return;
  }

  const createdParentIssue = payload.created_parent_issue;
  const parentIssueUrl = String(createdParentIssue?.issue_url || payload.parent_issue || "").trim();
  writeOutput(cli.outputPath, {
    generated_at: String(
      payload.generated_at || new Date().toISOString().replace(/\.\d{3}Z$/, "Z")
    ),
    dry_run: false,
    repository: cli.repository,
    parent_issue: {
      issue_number:
        Number(createdParentIssue?.issue_number || 0) || parseIssueNumberFromUrl(parentIssueUrl),
      issue_url: parentIssueUrl,
      title: String(createdParentIssue?.title || cli.parentTitle),
      labels: Array.isArray(createdParentIssue?.labels)
        ? createdParentIssue.labels
        : cli.parentLabels,
    },
    task_issue: {
      issue_number: Number(payload.issue_number || 0),
      issue_url: String(payload.issue_url || ""),
      task_id: String(payload.task_id || ""),
      action: String(payload.action || ""),
    },
  });
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`create-parent-task failed: ${(error as Error).message}\n`);
    process.exit(1);
  });
}
