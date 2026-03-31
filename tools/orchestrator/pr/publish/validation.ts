import { existsSync } from "node:fs";
import path from "node:path";

import {
  createLocalPrePushPlan,
  executeLocalPrePushPlan,
  type LocalPrePushOptions,
  type LocalPrePushPlan,
} from "../../../../platform/delivery/ci/local-pre-push";
import { uniqueStrings } from "./common";
import type { Cli, PublishLocalValidationResult } from "./contracts";
import { collectChangedFiles, resolveDiffBase } from "./git";

export function buildPublishLocalValidationOptions(
  repoRoot: string,
  cli: Pick<Cli, "baseBranch" | "branch" | "headRef" | "sourcePath">
): LocalPrePushOptions {
  return {
    baseRef: resolveDiffBase(repoRoot, cli.baseBranch),
    branch: cli.branch,
    cwd: repoRoot,
    headRef: cli.headRef,
    sourcePath: cli.sourcePath || undefined,
  };
}

export function withScopedPublishTaskIssueSourceEnv<T>(
  sourcePath: string | undefined,
  action: () => T
): T {
  const normalizedSourcePath = String(sourcePath || "").trim();
  const previousTaskIssueSource = Bun.env.OMTA_TASK_ISSUE_SOURCE;
  const previousIssueGraphSource = Bun.env.ISSUE_GRAPH_SOURCE;

  if (normalizedSourcePath) {
    Bun.env.OMTA_TASK_ISSUE_SOURCE = normalizedSourcePath;
    Bun.env.ISSUE_GRAPH_SOURCE = normalizedSourcePath;
  }

  try {
    return action();
  } finally {
    if (previousTaskIssueSource === undefined) {
      Bun.env.OMTA_TASK_ISSUE_SOURCE = undefined;
    } else {
      Bun.env.OMTA_TASK_ISSUE_SOURCE = previousTaskIssueSource;
    }
    if (previousIssueGraphSource === undefined) {
      Bun.env.ISSUE_GRAPH_SOURCE = undefined;
    } else {
      Bun.env.ISSUE_GRAPH_SOURCE = previousIssueGraphSource;
    }
  }
}

export function buildPublishLocalValidationResult(options: {
  fallbackChangedFiles: string[];
  fallbackValidationCommands: string[];
  plan: Pick<LocalPrePushPlan, "changedFiles" | "commands"> | null;
}): PublishLocalValidationResult {
  return {
    changedFiles: uniqueStrings(
      options.plan && options.plan.changedFiles.length > 0
        ? options.plan.changedFiles
        : options.fallbackChangedFiles
    ),
    validationCommands: uniqueStrings(
      options.plan && options.plan.commands.length > 0
        ? options.plan.commands
        : options.fallbackValidationCommands
    ),
  };
}

export function resolvePublishLocalValidation(options: {
  repoRoot: string;
  cli: Pick<Cli, "baseBranch" | "headRef" | "sourcePath" | "dryRun"> & { branch: string };
  fallbackValidationCommands: string[];
}): PublishLocalValidationResult {
  const hookPath = path.join(options.repoRoot, "platform/delivery/ci/local-pre-push.ts");
  if (!existsSync(hookPath)) {
    return buildPublishLocalValidationResult({
      fallbackChangedFiles: collectChangedFiles(
        options.repoRoot,
        options.cli.baseBranch,
        options.cli.headRef
      ),
      fallbackValidationCommands: options.fallbackValidationCommands,
      plan: null,
    });
  }

  process.stdout.write(
    `[pr-publish] local validation: planning canonical verify:task checks for ${options.cli.headRef} -> ${options.cli.baseBranch}\n`
  );
  return withScopedPublishTaskIssueSourceEnv(options.cli.sourcePath || undefined, () => {
    const plan = createLocalPrePushPlan(
      buildPublishLocalValidationOptions(options.repoRoot, {
        baseBranch: options.cli.baseBranch,
        branch: options.cli.branch,
        headRef: options.cli.headRef,
        sourcePath: options.cli.sourcePath,
      })
    );
    process.stdout.write(
      `[pr-publish] local validation: selected ${plan.commands.length} command(s)\n`
    );
    if (plan.verifyCacheFingerprint) {
      process.stdout.write(
        `[pr-publish] verify cache: ${plan.verifyCacheHit ? "hit" : "miss"} (${plan.verifyCacheFingerprint}${plan.verifyCacheReason ? `; ${plan.verifyCacheReason}` : ""})\n`
      );
    }
    if (plan.verifyCacheDetail) {
      process.stdout.write(`[pr-publish] verify cache detail: ${plan.verifyCacheDetail}\n`);
    }
    if (!options.cli.dryRun) {
      process.stdout.write("[pr-publish] local validation: executing command plan\n");
      executeLocalPrePushPlan(plan, {
        cwd: options.repoRoot,
        headRef: options.cli.headRef,
      });
      process.stdout.write("[pr-publish] local validation: completed\n");
    }

    return buildPublishLocalValidationResult({
      fallbackChangedFiles:
        plan.changedFiles.length > 0
          ? []
          : collectChangedFiles(options.repoRoot, options.cli.baseBranch, options.cli.headRef),
      fallbackValidationCommands: options.fallbackValidationCommands,
      plan,
    });
  });
}
