#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { Command } from "commander";

import { resolveRepoRoot } from "../../adapters/cli";
import { resolveTaskStartScriptPath } from "../../adapters/worktree";

function fail(message: string): never {
  process.stderr.write(`[deliver-execution-event-export] ERROR: ${message}\n`);
  process.exit(1);
}

function main(): void {
  const program = new Command()
    .name("deliver-execution-event-export")
    .description(
      "Operator lane for execution-event-export work: wt:start, then (after commits) PR publish/merge from the task worktree."
    )
    .requiredOption("--task-id <id>", "Canonical task id (e.g. API-260320184400)")
    .requiredOption("--slug <slug>", "Short slug for the task branch (passed to wt-task-start)")
    .option("--dry-run", "Forward --dry-run to wt-task-start only", false)
    .option(
      "--skip-wt-start",
      "Skip wt-task-start (task worktree must already exist under ../wt/<TASK_ID>)",
      false
    )
    .option(
      "--publish",
      "Run pr:publish from the task worktree (requires --skip-wt-start and local commits)",
      false
    )
    .option("--merge-pr <n>", "Run pr:merge:safe -- --pr <n> from the task worktree")
    .allowExcessArguments(false);

  program.parse(process.argv);
  const opts = program.opts<{
    taskId: string;
    slug: string;
    dryRun: boolean;
    skipWtStart: boolean;
    publish: boolean;
    mergePr?: string;
  }>();

  const taskId = String(opts.taskId || "").trim();
  const slug = String(opts.slug || "").trim();
  if (!taskId) fail("--task-id is required");
  if (!slug) fail("--slug is required");

  if (opts.publish && !opts.skipWtStart) {
    fail(
      "Refusing --publish without --skip-wt-start: commit your execution-event-export changes in the task worktree first, then re-run with --skip-wt-start --publish."
    );
  }

  const repoRoot = resolveRepoRoot();
  const wtPath = path.resolve(repoRoot, "..", "wt", taskId);
  const wtStart = resolveTaskStartScriptPath(repoRoot);

  if (!opts.skipWtStart) {
    if (!existsSync(wtStart)) {
      fail(`missing ${wtStart}`);
    }
    const args = [wtStart, "--task-id", taskId, "--slug", slug];
    if (opts.dryRun) {
      args.push("--dry-run");
    }
    const started = spawnSync("bash", args, { stdio: "inherit", cwd: repoRoot });
    if (started.error) {
      fail(String(started.error.message));
    }
    if (started.status !== 0) {
      fail("wt-task-start.sh exited non-zero");
    }
    if (opts.dryRun) {
      process.stdout.write("[deliver-execution-event-export] dry-run complete.\n");
      process.exit(0);
    }
  } else if (!existsSync(path.join(wtPath, ".git"))) {
    fail(`--skip-wt-start but task worktree is missing or not a git repo: ${wtPath}`);
  }

  if (opts.publish) {
    const pub = spawnSync("bun", ["run", "pr:publish"], { stdio: "inherit", cwd: wtPath });
    if (pub.status !== 0) {
      fail("pr:publish exited non-zero");
    }
  }

  const mergePr = String(opts.mergePr ?? "").trim();
  if (mergePr) {
    if (!/^\d+$/.test(mergePr)) {
      fail("--merge-pr must be a numeric PR id");
    }
    const merged = spawnSync("bun", ["run", "pr:merge:safe", "--", "--pr", mergePr], {
      stdio: "inherit",
      cwd: wtPath,
    });
    if (merged.status !== 0) {
      fail("pr:merge:safe exited non-zero");
    }
  }

  if (!opts.publish && !mergePr && !opts.dryRun) {
    process.stdout.write(
      [
        "[deliver-execution-event-export] Task worktree created.",
        `  cd ${wtPath}`,
        "  # Implement changes (see docs/contracts/architecture/boundaries.md — execution-event-export / logs export).",
        '  git add -A && git commit -m "…"',
        `  bun run task:deliver:execution-event-export -- --task-id ${taskId} --slug ${slug} --skip-wt-start --publish`,
        `  bun run task:deliver:execution-event-export -- --task-id ${taskId} --slug ${slug} --skip-wt-start --merge-pr <n>`,
        "",
      ].join("\n")
    );
  }
}

main();
