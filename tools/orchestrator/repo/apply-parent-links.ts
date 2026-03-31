#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import path from "node:path";

import { Command } from "commander";

import { fail, runGh, writeOutput } from "../../adapters/cli";
import { loadTaskIssues, resolveRepository } from "../../core/task-governance";

type Cli = {
  inputPath: string;
  sourcePath: string;
  repository: string;
  dryRun: boolean;
  outputPath: string;
};

type ParentIssueReference = {
  issueNumber: number;
  repository: string;
};

type MappingItem = {
  taskId: string;
  parentIssue: ParentIssueReference;
};

type ApplyResult = {
  task_id: string;
  child_issue_number: number;
  parent_issue_number: number;
  action: "already_linked" | "link_planned" | "linked";
};

function canonicalRepositorySlug(value: string): string {
  const parsed = resolveRepository(value);
  return `${parsed.owner.toLowerCase()}/${parsed.repo.toLowerCase()}`;
}

function parseIssueReference(value: unknown, field: string): ParentIssueReference {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value <= 0) {
      fail(`${field} must be a positive issue number`);
    }
    return {
      issueNumber: value,
      repository: "",
    };
  }

  if (typeof value !== "string") {
    fail(`${field} must be an issue number or issue URL`);
  }

  const trimmed = value.trim();
  if (!trimmed) {
    fail(`${field} must not be empty`);
  }

  if (/^\d+$/.test(trimmed)) {
    const number = Number(trimmed);
    if (!Number.isInteger(number) || number <= 0) {
      fail(`${field} must be a positive issue number`);
    }
    return {
      issueNumber: number,
      repository: "",
    };
  }

  const matched = trimmed.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/i);
  if (!matched) {
    fail(`${field} must be an issue number or issue URL`);
  }

  return {
    issueNumber: Number(matched[3]),
    repository: `${matched[1].toLowerCase()}/${matched[2].toLowerCase()}`,
  };
}

function parseCli(argv: string[]): Cli {
  const program = new Command()
    .name("apply-parent-links")
    .description("Apply parent issue sub-issue links from a mapping JSON")
    .requiredOption("--input <path>", "Mapping JSON path")
    .option("--source <path>", "Offline issue source JSON")
    .requiredOption("--repository <slug>", "Target repository <owner/repo>")
    .option("--dry-run", "Do not mutate GitHub links", false)
    .option("--output <path>", "JSON result output path")
    .addHelpText(
      "after",
      ["", "Input JSON:", '  {"items":[{"task_id":"OPS-1001","parent_issue":123}]}'].join("\n")
    )
    .parse(["node", "apply-parent-links", ...argv]);

  const opts = program.opts<{
    input: string;
    source?: string;
    repository: string;
    dryRun: boolean;
    output?: string;
  }>();

  return {
    inputPath: opts.input,
    sourcePath: opts.source || "",
    repository: opts.repository,
    dryRun: opts.dryRun,
    outputPath: opts.output || "",
  };
}

function parseJsonFile(filePath: string): unknown {
  const absolute = path.resolve(filePath);
  const raw = readFileSync(absolute, "utf8");
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    fail(`invalid JSON (${filePath}): ${(error as Error).message}`);
  }
}

function parseMappingItems(raw: unknown): MappingItem[] {
  const payload = parseMappingPayload(raw);
  const entries = payload.items;

  if (entries.length === 0) {
    fail("mapping payload must include at least one item");
  }

  return entries.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      fail(`mapping.items[${index}] must be an object`);
    }
    const item = entry as Record<string, unknown>;
    if (Object.hasOwn(item, "taskId")) {
      fail(`mapping.items[${index}].taskId is unsupported (use task_id)`);
    }
    const unsupportedParentAliases = [
      "parentIssue",
      "parentIssueNumber",
      "parentIssueUrl",
      "parent_issue_number",
      "parent_issue_url",
    ];
    for (const alias of unsupportedParentAliases) {
      if (Object.hasOwn(item, alias)) {
        fail(`mapping.items[${index}].${alias} is unsupported (use parent_issue)`);
      }
    }
    const allowedKeys = new Set(["task_id", "parent_issue"]);
    for (const key of Object.keys(item)) {
      if (!allowedKeys.has(key)) {
        fail(`mapping.items[${index}].${key} is unsupported`);
      }
    }
    const taskId = String(item.task_id ?? "").trim();
    if (!taskId) {
      fail(`mapping.items[${index}].task_id is required`);
    }

    const parentIssue = parseIssueReference(
      item.parent_issue,
      `mapping.items[${index}].parent_issue`
    );

    return {
      taskId,
      parentIssue,
    };
  });
}

function parseMappingPayload(raw: unknown): { items: unknown[] } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail("mapping payload must be an object");
  }
  const payload = raw as Record<string, unknown>;
  if (!Array.isArray(payload.items)) {
    fail("mapping payload must include items array");
  }
  return { items: payload.items };
}

function parseCurrentParentIssueNumber(repository: string, issueNumber: number): number {
  try {
    const stdout = runGh(["api", `repos/${repository}/issues/${issueNumber}/parent`]);
    const parsed = JSON.parse(stdout || "{}") as { number?: unknown };
    const number = Number(parsed.number || 0);
    if (!Number.isInteger(number) || number <= 0) {
      fail(`gh api parent returned invalid issue number for #${issueNumber}`);
    }
    return number;
  } catch (error) {
    const text = String((error as Error).message || "");
    if (/\b404\b/i.test(text) || /not found/i.test(text)) {
      return 0;
    }
    throw error;
  }
}

function fetchIssueRestId(repository: string, issueNumber: number): number {
  const stdout = runGh(["api", `repos/${repository}/issues/${issueNumber}`]);
  const parsed = JSON.parse(stdout || "{}") as { id?: unknown };
  const issueId = Number(parsed.id || 0);
  if (!Number.isInteger(issueId) || issueId <= 0) {
    fail(`failed to resolve issue id for #${issueNumber}`);
  }
  return issueId;
}

function linkSubIssue(
  repository: string,
  parentIssueNumber: number,
  childIssueNumber: number
): void {
  runGh([
    "api",
    "-X",
    "POST",
    `repos/${repository}/issues/${parentIssueNumber}/sub_issues`,
    "-F",
    `sub_issue_id=${fetchIssueRestId(repository, childIssueNumber)}`,
  ]);
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  const payload = parseJsonFile(cli.inputPath);
  const mappingItems = parseMappingItems(payload);

  const defaultRepository = resolveRepository(cli.repository);
  const resolvedRepository = `${defaultRepository.owner}/${defaultRepository.repo}`;
  const normalizedRepository = canonicalRepositorySlug(resolvedRepository);

  const { issues } = await loadTaskIssues({
    sourcePath: cli.sourcePath || undefined,
    repository: resolvedRepository,
  });
  const issueByTaskId = new Map<string, (typeof issues)[number]>();
  for (const issue of issues) {
    const taskId = String(issue.metadata.task_id || "").trim();
    if (!taskId) continue;
    const duplicate = issueByTaskId.get(taskId);
    if (duplicate) {
      fail(`duplicate task_id in issue source: ${taskId} (#${duplicate.number}, #${issue.number})`);
    }
    issueByTaskId.set(taskId, issue);
  }

  const results: ApplyResult[] = [];

  for (const item of mappingItems) {
    const issue = issueByTaskId.get(item.taskId);
    if (!issue) {
      fail(`task_id not found in issue graph: ${item.taskId}`);
    }

    const parentRepository = item.parentIssue.repository || normalizedRepository;
    if (canonicalRepositorySlug(parentRepository) !== normalizedRepository) {
      fail(
        `task_id ${item.taskId} parent_issue repository mismatch: expected=${normalizedRepository} actual=${parentRepository}`
      );
    }

    if (item.parentIssue.issueNumber === issue.number) {
      fail(`task_id ${item.taskId} cannot set its own issue #${issue.number} as parent`);
    }

    const currentParent = parseCurrentParentIssueNumber(normalizedRepository, issue.number);
    if (currentParent === item.parentIssue.issueNumber) {
      results.push({
        task_id: item.taskId,
        child_issue_number: issue.number,
        parent_issue_number: item.parentIssue.issueNumber,
        action: "already_linked",
      });
      continue;
    }

    if (currentParent > 0 && currentParent !== item.parentIssue.issueNumber) {
      fail(
        `task_id ${item.taskId} already has parent issue #${currentParent} (requested #${item.parentIssue.issueNumber})`
      );
    }

    if (cli.dryRun) {
      results.push({
        task_id: item.taskId,
        child_issue_number: issue.number,
        parent_issue_number: item.parentIssue.issueNumber,
        action: "link_planned",
      });
      continue;
    }

    linkSubIssue(normalizedRepository, item.parentIssue.issueNumber, issue.number);
    results.push({
      task_id: item.taskId,
      child_issue_number: issue.number,
      parent_issue_number: item.parentIssue.issueNumber,
      action: "linked",
    });
  }

  const summary = {
    generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    repository: normalizedRepository,
    dry_run: cli.dryRun,
    count: results.length,
    results,
  };

  writeOutput(cli.outputPath, summary);
  process.stdout.write(
    `apply-parent-links completed | repository=${normalizedRepository} | dry_run=${cli.dryRun} | count=${results.length}\n`
  );
}

main().catch((error) => {
  process.stderr.write(`apply-parent-links failed: ${(error as Error).message}\n`);
  process.exit(1);
});
