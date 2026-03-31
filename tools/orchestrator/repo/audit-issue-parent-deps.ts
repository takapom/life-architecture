#!/usr/bin/env bun

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { Command } from "commander";

import { loadTaskIssues } from "../../core/task-governance";

type Cli = {
  repository: string;
  sourcePath: string;
  outputPath: string;
};

type ParentViolation = {
  issue_number: number;
  task_id: string;
  title: string;
};

type BlockedByViolation = {
  issue_number: number;
  task_id: string;
  blocked_by: number[];
};

type Report = {
  generated_at: string;
  count: {
    parent_missing: number;
    native_dependency_edges: number;
  };
  parent_missing: ParentViolation[];
  native_dependency_edges: BlockedByViolation[];
};

function nowIsoUtc(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function parseCli(argv: string[]): Cli {
  const program = new Command()
    .name("audit-issue-parent-deps")
    .description("Audit task issues for unlinked parent references and blocked-by usage")
    .requiredOption("--repository <slug>", "Target repository <owner/repo>")
    .option("--source <path>", "Offline issue JSON source (ISSUE_GRAPH_SOURCE)")
    .option("--output <path>", "JSON report output path")
    .parse(["node", "audit-issue-parent-deps", ...argv]);

  const opts = program.opts<{
    repository: string;
    source?: string;
    output?: string;
  }>();

  return {
    repository: opts.repository,
    sourcePath: opts.source || "",
    outputPath: opts.output || "",
  };
}

function writeReport(outputPath: string, report: Report): void {
  if (!outputPath) return;
  const absolute = path.resolve(outputPath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  const { issues } = await loadTaskIssues({
    sourcePath: cli.sourcePath || undefined,
    repository: cli.repository,
  });

  const parentMissing: ParentViolation[] = [];
  const blockedByUsed: BlockedByViolation[] = [];

  for (const issue of issues) {
    const parentIssueNumber = Number(issue.graph.parent || 0);
    if (!Number.isInteger(parentIssueNumber) || parentIssueNumber <= 0) {
      parentMissing.push({
        issue_number: issue.number,
        task_id: issue.metadata.task_id,
        title: issue.title,
      });
    }

    if (issue.graph.blockedBy.length > 0) {
      blockedByUsed.push({
        issue_number: issue.number,
        task_id: issue.metadata.task_id,
        blocked_by: issue.graph.blockedBy,
      });
    }
  }

  const report: Report = {
    generated_at: nowIsoUtc(),
    count: {
      parent_missing: parentMissing.length,
      native_dependency_edges: blockedByUsed.length,
    },
    parent_missing: parentMissing,
    native_dependency_edges: blockedByUsed,
  };

  writeReport(cli.outputPath, report);

  process.stdout.write(
    `${[
      `audit complete | parent_missing=${report.count.parent_missing} | native_dependency_edges=${report.count.native_dependency_edges}`,
      report.count.parent_missing > 0
        ? `- parent_missing task_ids (informational for standalone-task review): ${parentMissing.map((entry) => entry.task_id).join(", ")}`
        : "- parent_missing task_ids: none",
      report.count.native_dependency_edges > 0
        ? `- native_dependency_edge task_ids: ${blockedByUsed.map((entry) => entry.task_id).join(", ")}`
        : "- native_dependency_edge task_ids: none",
      cli.outputPath ? `- report: ${path.resolve(cli.outputPath)}` : "",
    ]
      .filter(Boolean)
      .join("\n")}\n`
  );
}

main().catch((error) => {
  process.stderr.write(`audit-issue-parent-deps failed: ${(error as Error).message}\n`);
  process.exit(1);
});
