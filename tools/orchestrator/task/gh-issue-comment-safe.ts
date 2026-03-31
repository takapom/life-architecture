#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";

type CliOptions = {
  bodyFile: string;
  dryRun: boolean;
  issue: string;
  passthroughArgs: string[];
  repository: string;
};

function usage(): string {
  return `Usage:
  bun run task:issue:comment:safe -- --issue <number|url> --body-file <path> [options] [-- <gh-flags>]

Options:
  --issue <value>       Issue number or URL (required)
  --body-file <path>    Comment body file (required)
  --repo <owner/repo>   Repository override
  --dry-run             Print command without posting
  --help                Show this help

Notes:
  - This wrapper is fail-closed: it always uses --body-file.
  - Passing --body/-b via passthrough flags is rejected.`;
}

function writeStdoutLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

function fail(message: string): never {
  process.stderr.write(`[gh-issue-comment-safe] ERROR: ${message}\n`);
  process.exit(1);
}

function printUsageAndExit(): never {
  writeStdoutLine(usage());
  process.exit(0);
}

function parseArgs(argv: string[]): CliOptions {
  let issue = "";
  let bodyFile = "";
  let repository = "";
  let dryRun = false;
  let passthroughArgs: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--issue":
        issue = argv[index + 1] ?? "";
        if (!issue) {
          fail("missing value for --issue");
        }
        index += 1;
        break;
      case "--body-file":
        bodyFile = argv[index + 1] ?? "";
        if (!bodyFile) {
          fail("missing value for --body-file");
        }
        index += 1;
        break;
      case "--repo":
      case "-R":
        repository = argv[index + 1] ?? "";
        if (!repository) {
          fail(`missing value for ${arg}`);
        }
        index += 1;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--help":
      case "-h":
        return printUsageAndExit();
      case "--":
        passthroughArgs = argv.slice(index + 1);
        index = argv.length;
        break;
      default:
        fail(`unknown option: ${arg} (use -- to pass raw gh issue comment flags)`);
    }
  }

  return { issue, bodyFile, repository, dryRun, passthroughArgs };
}

function ensureExecutable(command: string): void {
  const result = spawnSync("sh", ["-c", `command -v "${command}" >/dev/null 2>&1`], {
    stdio: "ignore",
  });
  if (result.status !== 0) {
    fail(`required command not found: ${command}`);
  }
}

function validateBodyFile(bodyFile: string): void {
  if (!bodyFile) {
    fail("--body-file is required");
  }
  if (!existsSync(bodyFile)) {
    fail(`--body-file does not exist: ${bodyFile}`);
  }
  if (!statSync(bodyFile).isFile()) {
    fail(`--body-file is not a file: ${bodyFile}`);
  }
  try {
    accessSync(bodyFile, constants.R_OK);
  } catch {
    fail(`--body-file is not readable: ${bodyFile}`);
  }
}

function validatePassthroughFlags(passthroughArgs: string[]): void {
  for (const arg of passthroughArgs) {
    if (
      arg === "-b" ||
      arg === "--body" ||
      arg === "-F" ||
      arg === "--body-file" ||
      arg.startsWith("--body=") ||
      arg.startsWith("--body-file=")
    ) {
      fail(`do not pass ${arg} via passthrough; this wrapper enforces --body-file`);
    }
  }
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function runSafeIssueComment(options: CliOptions): void {
  if (!options.issue) {
    fail("--issue is required");
  }

  validateBodyFile(options.bodyFile);
  validatePassthroughFlags(options.passthroughArgs);
  ensureExecutable("gh");

  const command = ["issue", "comment", options.issue, "--body-file", options.bodyFile];
  if (options.repository) {
    command.push("--repo", options.repository);
  }
  command.push(...options.passthroughArgs);

  if (options.dryRun) {
    writeStdoutLine(
      `[gh-issue-comment-safe] dry-run: ${["gh", ...command].map(shellQuote).join(" ")}`
    );
    return;
  }

  const result = spawnSync("gh", command, {
    stdio: "inherit",
  });
  if (result.error) {
    fail(`failed to start gh: ${result.error.message}`);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (import.meta.path === Bun.main) {
  runSafeIssueComment(parseArgs(process.argv.slice(2)));
}
