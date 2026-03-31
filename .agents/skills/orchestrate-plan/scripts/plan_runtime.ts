#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

type Command = "intake-upsert" | "intake-validate";

function usage(): string {
  return [
    "Usage:",
    "  bun plan_runtime.ts intake-upsert [issue_runtime flags]",
    "  bun plan_runtime.ts intake-validate [register_runtime flags]",
    "",
    "Standard intake flow:",
    "  bun plan_runtime.ts intake-upsert --input .tmp/task-issues.json --dry-run --repository owner/repo --parent-issue 900",
    "  bun plan_runtime.ts intake-validate --repository owner/repo [--source ./.tmp/issues.json]",
  ].join("\n");
}

function fail(message: string): never {
  throw new Error(message);
}

function runBun(scriptPath: string, args: string[]): never {
  const result = spawnSync("bun", [scriptPath, ...args], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: process.env,
  });

  if (result.error) {
    fail(`failed to spawn bun for ${path.basename(scriptPath)}: ${result.error.message}`);
  }

  process.exit(result.status ?? 1);
}

function main(): void {
  const [commandRaw, ...rest] = process.argv.slice(2);
  if (!commandRaw || commandRaw === "--help" || commandRaw === "-h") {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }

  if (commandRaw === "register-build") {
    fail(
      "register-build is no longer part of the standard intake surface; derive any ad-hoc execution-plan export outside intake"
    );
  }
  if (commandRaw === "register-validate") {
    fail(
      "register-validate is no longer part of the standard intake surface; use intake-validate for task-issue and derived execution-plan validation"
    );
  }

  const command = commandRaw as Command;
  const skillRoot = path.resolve(import.meta.dir, "..");
  const issueRuntime = path.join(skillRoot, "scripts", "issue_runtime.ts");
  const registerRuntime = path.join(skillRoot, "scripts", "register_runtime.ts");

  if (!existsSync(issueRuntime)) fail(`issue runtime not found: ${issueRuntime}`);
  if (!existsSync(registerRuntime)) fail(`register runtime not found: ${registerRuntime}`);

  switch (command) {
    case "intake-upsert":
      runBun(issueRuntime, ["upsert-task-issues", ...rest]);
      break;
    case "intake-validate":
      runBun(registerRuntime, ["validate", ...rest]);
      break;
    default:
      fail(`unknown command: ${commandRaw}`);
  }
}

try {
  main();
} catch (error) {
  console.error(`plan_runtime failed: ${(error as Error).message}`);
  process.exit(1);
}
