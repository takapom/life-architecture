import { spawnSync } from "node:child_process";

export function usage(): string {
  return `Usage:
  bun run pr:merge:safe -- --pr <number|url> [options]

Options:
  --pr <value>          Pull request number or URL (required)
  --method <value>      merge method: squash | merge | rebase (default: squash)
  --no-queue            Merge directly without queue/auto-merge
  --require-queue       Fail closed unless queue/auto-merge is available
  --cleanup             Apply exact-sync PR/worktree cleanup from the resolved main worktree; post-merge verification stays separate (default: off)
  --cleanup-only        Skip merge and run only the scoped cleanup path for an already merged PR
  --repository <value>  owner/repo for cleanup fallback API (used with --cleanup)
  --dry-run             Print commands without executing mutating operations
  --help                Show this help`;
}

export function writeStdoutLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

export function fail(message: string): never {
  process.stderr.write(`[pr-merge-safe] ERROR: ${message}\n`);
  process.exit(1);
}

export function printUsageAndExit(): never {
  writeStdoutLine(usage());
  process.exit(0);
}

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:%=-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function runGit(
  repoRoot: string,
  args: string[],
  options: { allowFailure?: boolean } = {}
): string {
  const result = spawnSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
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
): { stderr: string; stdout: string; status: number } {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = String(result.stdout || "").trim();
  const stderr = String(result.stderr || "").trim();
  const status = result.status ?? 1;
  if (result.error) {
    fail(`failed to start gh: ${result.error.message}`);
  }
  if (status !== 0 && !options.allowFailure) {
    const detail = `${stderr}\n${stdout}`.trim();
    fail(`gh ${args.join(" ")} failed: ${detail || `exit=${status}`}`);
  }
  return { stderr, stdout, status };
}

export function runCommand(command: string, args: string[], options: { cwd?: string } = {}): void {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    stdio: "inherit",
  });
  if (result.error) {
    fail(`failed to start ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

export function printDryRun(args: string[]): void {
  writeStdoutLine(`[pr-merge-safe] dry-run: ${args.map(shellQuote).join(" ")}`);
}

export function isQueueUnavailable(detail: string): boolean {
  return (
    /auto-merge is not enabled/i.test(detail) ||
    /auto merge is not enabled/i.test(detail) ||
    /auto-merge is disabled/i.test(detail) ||
    /auto merge is disabled/i.test(detail) ||
    /merge queue.*not enabled/i.test(detail) ||
    /merge queue.*not available/i.test(detail) ||
    /merge queue.*disabled/i.test(detail) ||
    /does not support merge queue/i.test(detail)
  );
}
