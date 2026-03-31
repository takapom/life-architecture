import { spawnSync } from "node:child_process";
import path from "node:path";

import { appendToolOperationalEvidence } from "../../adapters/tool-operational-evidence";
import type { Cli } from "./orchestrator-cli";
import {
  appendOperatorCommandEvent,
  type OperatorLifecycleCommand,
  withSessionWriterLock,
} from "./runtime_lifecycle";

export type DelegatedInvocation = {
  scriptPath: string;
  args: string[];
};

function fail(message: string): never {
  throw new Error(message);
}

function invokeBun(scriptPath: string, args: string[], cwd: string): void {
  const result = spawnSync("bun", [scriptPath, ...args], {
    cwd,
    env: Bun.env,
    stdio: "inherit",
  });
  if (result.error) {
    fail(`failed to spawn bun for ${path.basename(scriptPath)}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`${path.basename(scriptPath)} ${args.join(" ")} failed: exit=${result.status ?? 1}`);
  }
}

function pushValueFlag(args: string[], flag: string, value: string): void {
  if (!value.trim()) return;
  args.push(flag, value.trim());
}

function validateExecutionSelector(cli: Cli): void {
  if (!cli.parentIssue.trim()) return;
  fail(
    "parent issue execution routing is removed; start/resume must target a child task issue via --issue while parent issues remain tracking-only"
  );
}

export function buildDelegatedInvocation(repoRoot: string, cli: Cli): DelegatedInvocation {
  const executeScript = path.join(repoRoot, "tools/orchestrator/runtime/execute.ts");
  const closeScript = path.join(repoRoot, "tools/orchestrator/runtime/close.ts");
  const tmuxScript = path.join(repoRoot, "tools", "orchestrator", "orchestrator-tmux.ts");

  switch (cli.command) {
    case "start":
    case "resume": {
      validateExecutionSelector(cli);
      const args = ["run"];
      pushValueFlag(args, "--repository", cli.repository);
      pushValueFlag(args, "--issue", cli.issue);
      pushValueFlag(args, "--state-backend", cli.stateBackend);
      pushValueFlag(args, "--state-dir", cli.stateDir);
      pushValueFlag(args, "--session-id", cli.sessionId);
      pushValueFlag(args, "--task-source", cli.taskSource);
      pushValueFlag(args, "--skills-config", cli.skillsConfig);
      pushValueFlag(args, "--profile", cli.profile);
      if (cli.allowDirtyBase) args.push("--allow-dirty-base");
      return { scriptPath: executeScript, args };
    }
    case "attach": {
      const args = ["attach"];
      pushValueFlag(args, "--session-id", cli.sessionId);
      pushValueFlag(args, "--state-dir", cli.stateDir);
      pushValueFlag(args, "--tmux-session", cli.tmuxSession);
      return { scriptPath: tmuxScript, args };
    }
    case "close": {
      const args = ["run"];
      if (!cli.repository.trim()) {
        fail("close requires --repository");
      }
      args.push("--repository", cli.repository);
      pushValueFlag(args, "--state-backend", cli.stateBackend);
      pushValueFlag(args, "--state-dir", cli.stateDir);
      pushValueFlag(args, "--session-id", cli.sessionId);
      pushValueFlag(args, "--run-issue", cli.runIssue);
      pushValueFlag(args, "--run-id", cli.runId);
      pushValueFlag(args, "--base-branch", cli.baseBranch);
      args.push("--skip-parent-issue-sync");
      return { scriptPath: closeScript, args };
    }
    case "status":
      fail("status does not delegate to another runtime");
  }
}

export function invokeDelegatedCommandWithRuntimeLifecycle(options: {
  repoRoot: string;
  cli: Cli;
  invocation: DelegatedInvocation;
  invoke?: (scriptPath: string, args: string[], cwd: string) => void;
  evidenceRoot?: string;
}): void {
  if (
    options.cli.command !== "start" &&
    options.cli.command !== "resume" &&
    options.cli.command !== "close"
  ) {
    (options.invoke || invokeBun)(
      options.invocation.scriptPath,
      options.invocation.args,
      options.repoRoot
    );
    return;
  }

  const command = options.cli.command satisfies OperatorLifecycleCommand;
  const delegatedScript = path.basename(options.invocation.scriptPath);
  const startedAt = Date.now();
  const appendCommandEvent = (
    stage: "started" | "completed" | "failed",
    detail = "",
    durationMs?: number
  ): void => {
    withSessionWriterLock(
      {
        stateDir: options.cli.stateDir,
        sessionId: options.cli.sessionId,
        ownerLabel: `orchestrator:${command}:metadata`,
      },
      () => {
        appendOperatorCommandEvent({
          stateDir: options.cli.stateDir,
          sessionId: options.cli.sessionId,
          command,
          stage,
          delegatedScript,
          detail,
          durationMs,
        });
      }
    );
  };

  appendCommandEvent("started");

  const invoke = options.invoke || invokeBun;
  try {
    invoke(options.invocation.scriptPath, options.invocation.args, options.repoRoot);
    const durationMs = Date.now() - startedAt;
    appendToolOperationalEvidence({
      toolId: "orchestrator",
      command,
      args: options.invocation.args,
      outcome: "success",
      repoRoot: options.repoRoot,
      cwd: options.repoRoot,
      durationMs,
      delegatedScript,
      evidenceRoot: options.evidenceRoot,
    });
    appendCommandEvent("completed", "", durationMs);
  } catch (error) {
    const primaryError = error instanceof Error ? error : new Error(String(error));
    const durationMs = Date.now() - startedAt;
    appendToolOperationalEvidence({
      toolId: "orchestrator",
      command,
      args: options.invocation.args,
      outcome: "failure",
      repoRoot: options.repoRoot,
      cwd: options.repoRoot,
      durationMs,
      detail: primaryError.message,
      delegatedScript,
      evidenceRoot: options.evidenceRoot,
    });
    appendCommandEvent("failed", primaryError.message, durationMs);
    throw primaryError;
  }
}
