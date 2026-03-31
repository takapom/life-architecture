import { existsSync } from "node:fs";
import path from "node:path";

import { readGithubRunContextFile } from "../../shared/github_run_context";
import { appendRuntimeEvent } from "../../shared/runtime_event_log";
import { withSessionWriterLock } from "../../shared/runtime_lifecycle";
import {
  resolveSessionArtifactPaths,
  writeSessionArtifactManifest,
} from "../../shared/session_artifacts";
import {
  fail,
  isObject,
  nowIsoUtc,
  parseIssueNumber,
  readJsonFile,
  runResult,
  writeJsonFile,
} from "./common";
import type { Command, JsonObject, ParentIssueSyncScope } from "./contracts";

export function emitSessionManifest(options: {
  stateDir: string;
  sessionId: string;
  stateBackend: "github" | "local";
  repository: string;
  command: "close:verify" | "close:run" | "close:cleanup-plan" | "close:cleanup-apply";
  fileOverride?: Parameters<typeof writeSessionArtifactManifest>[0]["fileOverride"];
}): void {
  if (!options.repository.trim()) return;

  writeSessionArtifactManifest({
    stateDir: options.stateDir,
    sessionId: options.sessionId,
    stateBackend: options.stateBackend,
    repository: options.repository,
    command: options.command,
    fileOverride: options.fileOverride,
  });
}

export function appendCloseRuntimeEvent(options: {
  stateDir: string;
  sessionId: string;
  eventType: string;
  payload?: Record<string, unknown>;
}): void {
  appendRuntimeEvent({
    stateDir: options.stateDir,
    sessionId: options.sessionId,
    eventType: options.eventType,
    payload: options.payload,
  });
}

export function runCloseCommandWithLifecycle(options: {
  stateDir: string;
  sessionId: string;
  command: Command;
  run: () => void;
}): void {
  withSessionWriterLock(
    {
      stateDir: options.stateDir,
      sessionId: options.sessionId,
      ownerLabel: `close:${options.command}`,
    },
    () => {
      appendCloseRuntimeEvent({
        stateDir: options.stateDir,
        sessionId: options.sessionId,
        eventType: "close.command.started",
        payload: {
          command: options.command,
        },
      });
      try {
        options.run();
        appendCloseRuntimeEvent({
          stateDir: options.stateDir,
          sessionId: options.sessionId,
          eventType: "close.command.completed",
          payload: {
            command: options.command,
          },
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        appendCloseRuntimeEvent({
          stateDir: options.stateDir,
          sessionId: options.sessionId,
          eventType: "close.command.failed",
          payload: {
            command: options.command,
            error_message: detail,
          },
        });
        throw error;
      }
    }
  );
}

export function resolveGithubRunContextForClose(options: {
  cliRepository: string;
  cliRunId: string;
  cliRunIssue: string;
  stateBackend: "github" | "local";
  stateDir: string;
}): {
  repository: string;
  runId: string;
  runIssueNumber: number;
} {
  if (options.stateBackend !== "github") {
    return {
      repository: options.cliRepository.trim(),
      runId: options.cliRunId.trim(),
      runIssueNumber: options.cliRunIssue ? parseIssueNumber(options.cliRunIssue) : 0,
    };
  }

  const context = readGithubRunContextFile(options.stateDir);
  const cliRepository = options.cliRepository.trim();
  const repository = cliRepository || context.repository;
  if (!repository) {
    fail("github close requires repository from --repository or github-run-context.json");
  }
  if (cliRepository && cliRepository !== context.repository) {
    fail(`github close repository mismatch: cli=${cliRepository} context=${context.repository}`);
  }

  const runId = options.cliRunId.trim() || context.run_id;
  if (!runId) {
    fail("github close requires run_id from --run-id or github-run-context.json");
  }

  const runIssueNumber = options.cliRunIssue
    ? parseIssueNumber(options.cliRunIssue)
    : context.run_issue_number;

  return {
    repository,
    runId,
    runIssueNumber,
  };
}

export function shouldRunParentIssueSync(
  stateBackend: "github" | "local",
  skipFlag: boolean
): boolean {
  return stateBackend === "github" && !skipFlag;
}

export function syncParentIssueStatus(options: {
  repoRoot: string;
  repository: string;
  stateDir: string;
  apply: boolean;
  parentIssueSyncScope: ParentIssueSyncScope;
}): JsonObject {
  const scriptPath = path.join(options.repoRoot, "scripts", "ops", "sync-parent-issue-status.ts");
  if (!existsSync(scriptPath)) {
    fail(`parent issue sync script not found: ${scriptPath}`);
  }
  const outputPath = resolveSessionArtifactPaths(options.stateDir).parentIssueSyncJson;
  if (options.parentIssueSyncScope.parentIssueNumbers.length === 0) {
    const summary = {
      generated_at: nowIsoUtc(),
      repository: options.repository,
      requested_parent_issue_numbers: [],
      applied: false,
      skipped: true,
      reason: "execution plan does not bound any parent issues",
    };
    writeJsonFile(outputPath, summary);
    return {
      ...summary,
      output_path: outputPath,
      bounded_scope: {
        execution_plan_path: options.parentIssueSyncScope.executionPlanPath,
        parent_issue_numbers: [],
      },
    };
  }

  const args = [scriptPath, "--repository", options.repository, "--output", outputPath];
  for (const parentIssueNumber of options.parentIssueSyncScope.parentIssueNumbers) {
    args.push("--parent-issue", String(parentIssueNumber));
  }
  if (options.apply) {
    args.push("--apply");
  } else {
    args.push("--dry-run");
  }

  const result = runResult("bun", args, options.repoRoot);
  if (result.status !== 0) {
    const detail = `${result.stderr}\n${result.stdout}`.trim();
    fail(`parent issue sync failed: ${detail || `exit=${result.status}`}`);
  }
  const summaryRaw = existsSync(outputPath) ? readJsonFile(outputPath) : {};
  if (!isObject(summaryRaw)) {
    fail("parent issue sync summary must be a JSON object");
  }
  return {
    ...summaryRaw,
    output_path: outputPath,
    bounded_scope: {
      execution_plan_path: options.parentIssueSyncScope.executionPlanPath,
      parent_issue_numbers: options.parentIssueSyncScope.parentIssueNumbers,
    },
  };
}
