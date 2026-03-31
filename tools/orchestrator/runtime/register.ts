#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateExecutionPlan } from "./execution-plan-contract";

type JsonObject = Record<string, unknown>;

type Command = "build" | "validate";

type ParsedCli = {
  command: Command;
  repository: string;
  source: string;
  output: string;
  baseBranch: string;
  maxWorkers: string;
};

function usage(): string {
  return [
    "Usage:",
    "  bun register.ts build --repository <owner/repo> [--source <issues.json>] [--output <path>] [--base-branch <name>] [--max-workers <n>]",
    "  bun register.ts validate --repository <owner/repo> [--source <issues.json>] [--base-branch <name>] [--max-workers <n>]",
    "",
    "Examples:",
    "  bun register.ts build --repository owner/repo --output .tmp/execution-plan.json",
    "  bun register.ts build --repository owner/repo --source ./.tmp/issues.json --output .tmp/execution-plan.json",
    "  bun register.ts validate --repository owner/repo --source ./.tmp/issues.json",
    "",
    "Validation contract:",
    "  - nodes[].github_issue is required and must be unique across nodes",
    "  - nodes[].covers must contain exactly one source id",
    "  - source_items[].parent_issue_number / parent_issue_url are optional, but when one is set both must be valid",
    "  - issue_map source IDs must not share the same issue URL",
    "  - nodes[].github_issue must match issue_map for covered source IDs",
  ].join("\n");
}

function fail(message: string): never {
  throw new Error(message);
}

function writeStdout(message: string): void {
  process.stdout.write(`${message}\n`);
}

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const detail = `${result.stderr || ""}\n${result.stdout || ""}`.trim();
    fail(`${command} ${args.join(" ")} failed: ${detail || `exit=${result.status}`}`);
  }
  return String(result.stdout || "").trim();
}

function parseCli(argv: string[]): ParsedCli {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }

  const commandRaw = argv[0]?.trim() || "";
  if (commandRaw !== "build" && commandRaw !== "validate") {
    fail(`unknown command: ${commandRaw}`);
  }

  const flags = new Map<string, string>();
  const allowedFlags = new Set(["repository", "source", "output", "base-branch", "max-workers"]);
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i] ?? "";
    if (!token.startsWith("--")) {
      fail(`unexpected positional argument: ${token}`);
    }
    const key = token.slice(2);
    if (!allowedFlags.has(key)) {
      fail(`unknown option: --${key}`);
    }
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      fail(`--${key} requires a value`);
    }
    flags.set(key, value);
    i += 1;
  }

  const repository = (flags.get("repository") || "").trim();
  const parsedRepository = parseRepositorySlug(repository);
  if (!parsedRepository) {
    fail("--repository is required and must be <owner>/<repo>");
  }

  return {
    command: commandRaw,
    repository: `${parsedRepository.owner}/${parsedRepository.repo}`,
    source: (flags.get("source") || "").trim(),
    output: (flags.get("output") || "").trim(),
    baseBranch: (flags.get("base-branch") || "").trim(),
    maxWorkers: (flags.get("max-workers") || "").trim(),
  };
}

function resolveRepoRoot(): string {
  const stdout = run("git", ["rev-parse", "--show-toplevel"], process.cwd());
  const root = stdout.trim();
  if (!root) fail("failed to resolve repository root");
  return root;
}

function runExecutionPlanExport(
  repoRoot: string,
  options: {
    repository: string;
    source: string;
    outputPath: string;
    baseBranch: string;
    maxWorkers: string;
  }
): void {
  const args = [
    "run",
    "execution-plan:from-issues",
    "--",
    "--repository",
    options.repository,
    "--output",
    options.outputPath,
  ];
  if (options.source) {
    args.push("--source", path.resolve(repoRoot, options.source));
  }
  if (options.baseBranch) {
    args.push("--base-branch", options.baseBranch);
  }
  if (options.maxWorkers) {
    args.push("--max-workers", options.maxWorkers);
  }
  run("bun", args, repoRoot);
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseRepositorySlug(value: string): { owner: string; repo: string } | null {
  const parts = value
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length !== 2) return null;
  return { owner: parts[0], repo: parts[1] };
}

export function validateHandoff(payload: unknown): string[] {
  return validateExecutionPlan(payload);
}

function readJson(filePath: string): unknown {
  const text = readFileSync(filePath, "utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    fail(`invalid JSON (${filePath}): ${(error as Error).message}`);
  }
}

function writeOutput(payload: unknown, outputPath: string): void {
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  if (outputPath) {
    const absolute = path.resolve(outputPath);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, text, "utf8");
    writeStdout(`handoff bundle written: ${absolute}`);
    return;
  }
  process.stdout.write(text);
}

function main(): void {
  const cli = parseCli(process.argv.slice(2));
  const repoRoot = resolveRepoRoot();

  const tempDir = mkdtempSync(path.join(os.tmpdir(), "ip-register-"));
  const tempOut = path.join(tempDir, "execution-plan.json");
  try {
    runExecutionPlanExport(repoRoot, {
      repository: cli.repository,
      source: cli.source,
      outputPath: tempOut,
      baseBranch: cli.baseBranch,
      maxWorkers: cli.maxWorkers,
    });

    const payload = readJson(tempOut);
    const errors = validateHandoff(payload);
    if (errors.length > 0) {
      fail(`handoff contract validation failed:\n- ${errors.join("\n- ")}`);
    }

    const parsed = payload as Record<string, unknown>;

    if (cli.command === "validate") {
      const nodes = Array.isArray(parsed.nodes) ? parsed.nodes.length : 0;
      const issueMap = isObject(parsed.issue_map) ? Object.keys(parsed.issue_map).length : 0;
      writeStdout(`register validation passed | nodes=${nodes} | issue_map=${issueMap}`);
      return;
    }

    writeOutput(parsed, cli.output);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`register failed: ${(error as Error).message}\n`);
    process.exit(1);
  }
}
