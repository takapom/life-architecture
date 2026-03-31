#!/usr/bin/env bun

import { parseCli, resolveRepoRoot, resolveRuntimeCli } from "./shared/orchestrator-cli";
import {
  buildDelegatedInvocation,
  invokeDelegatedCommandWithRuntimeLifecycle,
} from "./shared/orchestrator-delegation";
import { summarizeOperatorStatus } from "./shared/orchestrator-status";

export {
  buildDelegatedInvocation,
  invokeDelegatedCommandWithRuntimeLifecycle,
  summarizeOperatorStatus,
};

function main(): void {
  const cli = parseCli(process.argv.slice(2));
  const repoRoot = resolveRepoRoot();
  const runtimeCli = resolveRuntimeCli(repoRoot, cli);

  if (runtimeCli.command === "status") {
    process.stdout.write(
      `${JSON.stringify(
        summarizeOperatorStatus({
          repoRoot,
          sessionId: runtimeCli.sessionId,
          stateDir: runtimeCli.stateDir,
          tmuxSessionOverride: runtimeCli.tmuxSession,
        }),
        null,
        2
      )}\n`
    );
    return;
  }

  const invocation = buildDelegatedInvocation(repoRoot, runtimeCli);
  invokeDelegatedCommandWithRuntimeLifecycle({
    repoRoot,
    cli: runtimeCli,
    invocation,
  });
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`orchestrator failed: ${(error as Error).message}\n`);
    process.exit(1);
  }
}
