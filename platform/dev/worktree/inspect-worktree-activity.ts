#!/usr/bin/env bun

import path from "node:path";

import { fail } from "../../../tools/adapters/cli";
import { inspectCanonicalWorktreeActivity } from "./worktree-activity";

type CliOptions = {
  worktreePath: string;
};

function usage(): string {
  return `Usage: bun platform/dev/worktree/inspect-worktree-activity.ts [--worktree <path>]

Print the canonical read-only worktree writer-liveness inspection payload.
When --worktree is omitted, the current working directory is inspected.`;
}

function parseArgs(argv: string[]): CliOptions {
  let worktreePath = process.cwd();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] || "").trim();
    switch (arg) {
      case "--worktree": {
        const next = String(argv[index + 1] || "").trim();
        if (!next) {
          fail("--worktree requires a value");
        }
        worktreePath = next;
        index += 1;
        break;
      }
      case "--help":
      case "-h":
        process.stdout.write(`${usage()}\n`);
        process.exit(0);
        return { worktreePath: process.cwd() };
      default:
        fail(`unknown argument: ${arg}`);
    }
  }

  return {
    worktreePath: path.resolve(worktreePath),
  };
}

function main(): void {
  const cli = parseArgs(process.argv.slice(2));
  process.stdout.write(
    `${JSON.stringify(inspectCanonicalWorktreeActivity(cli.worktreePath), null, 2)}\n`
  );
}

main();
