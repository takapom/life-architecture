import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { fail } from "../../../adapters/cli";
import type { TaskSpec } from "../../../core/task-governance";
import { type ExpectedTaskIssue, renderCanonicalPrBody } from "../check-pr-body-traceability";
import { uniqueStrings } from "./common";
import type { CanonicalPrContent, Cli } from "./contracts";
import { normalizeTitleFromIssueTitle } from "./task-issue";

function writeGeneratedBodyFile(repoRoot: string, outputPath: string, body: string): string {
  const bodyFile = path.resolve(repoRoot, outputPath);
  mkdirSync(path.dirname(bodyFile), { recursive: true });
  writeFileSync(bodyFile, body, "utf8");
  return bodyFile;
}

export function buildCanonicalPrContent(
  repoRoot: string,
  cli: Cli,
  spec: TaskSpec,
  expectedTaskIssue: ExpectedTaskIssue,
  changedFiles: string[],
  validationCommands: string[]
): CanonicalPrContent {
  const title = cli.title || normalizeTitleFromIssueTitle(spec.title);
  if (!title) {
    fail(`canonical task issue #${expectedTaskIssue.issueNumber} has an empty title`);
  }

  const acceptanceCriteria =
    spec.acceptance_criteria.length > 0
      ? spec.acceptance_criteria
      : [normalizeTitleFromIssueTitle(spec.title)];
  const changeSummaryBullets =
    spec.commit_units.length > 0
      ? spec.commit_units.map((commitUnit) => commitUnit.replace(/^\s*CU\d+\s*:\s*/i, "").trim())
      : [spec.summary || normalizeTitleFromIssueTitle(spec.title)];
  const body = renderCanonicalPrBody({
    acceptanceCriteria,
    changeSummaryBullets,
    changedFiles,
    expectedTaskIssue,
    summary: spec.summary || normalizeTitleFromIssueTitle(spec.title),
    tests: uniqueStrings(validationCommands),
    title,
  });

  if (cli.bodyFile) {
    const bodyFile = path.resolve(repoRoot, cli.bodyFile);
    if (cli.dryRun) {
      return {
        body,
        bodyFile,
        cleanupBodyFile: false,
        title,
      };
    }
    return {
      body,
      bodyFile: writeGeneratedBodyFile(repoRoot, cli.bodyFile, body),
      cleanupBodyFile: false,
      title,
    };
  }

  const outputPath = path.join(os.tmpdir(), "omta-pr-publish-body-dry-run", "pr-body.md");
  if (cli.dryRun) {
    return {
      body,
      bodyFile: outputPath,
      cleanupBodyFile: false,
      title,
    };
  }

  const tempDir = mkdtempSync(path.join(os.tmpdir(), "omta-pr-publish-body-"));
  return {
    body,
    bodyFile: writeGeneratedBodyFile(repoRoot, path.join(tempDir, "pr-body.md"), body),
    cleanupBodyFile: true,
    title,
  };
}
