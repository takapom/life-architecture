import { spawnSync } from "node:child_process";

import { fail } from "../../../adapters/cli";

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@=-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function printDryRun(command: string, args: string[]): void {
  process.stdout.write(
    `[pr-publish] dry-run: ${[command, ...args].map((value) => shellQuote(value)).join(" ")}\n`
  );
}

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function runGit(
  repoRoot: string,
  args: string[],
  options: { allowFailure?: boolean; extraEnv?: NodeJS.ProcessEnv } = {}
): string {
  const result = spawnSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...Bun.env,
      ...(options.extraEnv || {}),
    },
  });
  if (result.status !== 0) {
    if (options.allowFailure) {
      return "";
    }
    const detail = `${result.stderr || ""}\n${result.stdout || ""}`.trim();
    fail(`git ${args.join(" ")} failed: ${detail || `exit=${result.status}`}`);
  }
  return String(result.stdout || "").trim();
}

export function runGh(
  args: string[],
  options: { allowFailure?: boolean } = {}
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: Bun.env,
  });
  const stdout = String(result.stdout || "").trim();
  const stderr = String(result.stderr || "").trim();
  const status = result.status ?? 1;
  if (status !== 0 && !options.allowFailure) {
    fail(`gh ${args.join(" ")} failed: ${stderr || stdout || `exit=${status}`}`);
  }
  return { stdout, stderr, status };
}
