import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { JsonObject } from "./contracts";

export function usage(): string {
  return [
    "Usage:",
    "  bun issue.ts upsert-task-issues --repository <owner/repo> [--parent-issue <number|url>] [--input <path>] [--issue-number <n>] [--create-only] [--dry-run] [--output <path>]",
    "",
    "Notes:",
    "  - --input can be omitted to read JSON from stdin.",
    "  - input payload must be an object with `items` array only.",
    "  - each item must include `task_id` and `issue` fields.",
    "  - parent issue is configured only by --parent-issue (payload parent fields are unsupported).",
    "  - omit --parent-issue for a standalone task issue.",
    "  - --parent-issue is required when upserting multiple task issues in one command.",
    "  - when provided, --parent-issue links each upserted issue as a GitHub Sub-issue of the given parent issue.",
    "  - --create-only fails if task_id already resolves to an open task issue.",
    "  - --repository is required; repository auto-detection is unsupported.",
    "  - upsert commands require GH auth (`GH_TOKEN` or `gh auth login`).",
    "  - labels must already exist in the repository; label auto-creation is not supported.",
  ].join("\n");
}

export function fail(message: string): never {
  throw new Error(message);
}

export function run(command: string, args: string[], cwd: string): string {
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

export function runResult(
  command: string,
  args: string[],
  cwd: string
): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: Number(result.status ?? 1),
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
  };
}

export function nowIsoUtc(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function ensureString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    fail(`${field} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    fail(`${field} must not be empty`);
  }
  return trimmed;
}

export function ensureObject(value: unknown, field: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${field} must be a JSON object`);
  }
  return value as JsonObject;
}

export function ensureInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    fail(`${field} must be a positive integer`);
  }
  return parsed;
}

export function parseJson(text: string, source: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    fail(`invalid JSON from ${source}: ${(error as Error).message}`);
  }
}

export function readTextFile(filePath: string): string {
  const absolute = path.resolve(filePath);
  if (!existsSync(absolute)) {
    fail(`file not found: ${filePath}`);
  }
  return readFileSync(absolute, "utf8");
}

export function readJsonFile(filePath: string): unknown {
  return parseJson(readTextFile(filePath), filePath);
}

export function readJsonFromInput(inputPath: string): unknown {
  if (inputPath) {
    return readJsonFile(inputPath);
  }
  if (process.stdin.isTTY) {
    fail("missing --input and no stdin payload");
  }
  const stdinText = readFileSync(0, "utf8");
  if (!stdinText.trim()) {
    fail("stdin JSON payload is empty");
  }
  return parseJson(stdinText, "stdin");
}

export function writeJsonOutput(payload: unknown, outputPath: string): void {
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  if (outputPath) {
    writeFileSync(path.resolve(outputPath), text, "utf8");
    return;
  }
  process.stdout.write(text);
}

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}
