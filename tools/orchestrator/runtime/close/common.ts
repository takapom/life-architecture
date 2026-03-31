import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { JsonObject } from "./contracts";

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

export function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseJson(text: string, source: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    fail(`invalid JSON (${source}): ${(error as Error).message}`);
  }
}

export function readJsonFile(filePath: string): unknown {
  if (!existsSync(filePath)) {
    fail(`required file not found: ${filePath}`);
  }
  return parseJson(readFileSync(filePath, "utf8"), filePath);
}

export function writeJsonFile(filePath: string, payload: unknown): void {
  const absolute = path.resolve(filePath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export function parseIssueNumber(value: string): number {
  const text = value.trim();
  const num = Number(text);
  if (!Number.isInteger(num) || num <= 0) {
    fail(`--run-issue must be a positive integer: ${value}`);
  }
  return num;
}

export function parsePrNumberFromUrl(value: string): string {
  const text = value.trim();
  if (!text) return "";
  const matched = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)(?:[/?#].*)?$/i.exec(text);
  if (!matched) return "";
  return matched[1] || "";
}

export function resolveOutputPath(value: string, fallback: string): string {
  const text = value.trim();
  return text ? path.resolve(text) : fallback;
}

export function resolveCanonicalPath(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  if (!existsSync(resolved)) {
    return resolved;
  }
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export function pathIsWithin(candidatePath: string, rootPath: string): boolean {
  const relative = path.relative(
    resolveCanonicalPath(rootPath),
    resolveCanonicalPath(candidatePath)
  );
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}
