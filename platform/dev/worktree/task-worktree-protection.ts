#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { fail } from "../../../tools/adapters/cli";
import { extractTaskIdFromBranch, normalizeTaskId } from "../../../tools/core/task-issue-guard";
import { canonicalPath, isInsidePath, shortBranch } from "./codex-write-scope";
import {
  resolveCanonicalTaskRootFromRepoRoot,
  resolveTaskWorktreeProtectionRootFromRepoRoot,
} from "./worktree-topology";

export const TASK_WORKTREE_PROTECTION_LEASE_MS = 72 * 60 * 60 * 1000;

export type TaskWorktreeProtectionLease = {
  version: 1;
  branch: string;
  taskId: string;
  reason: string;
  protectedUntil: string;
  updatedAt: string;
  worktreePath: string;
};

type CliOptions = {
  branch: string;
  reason: string;
  repoRoot: string;
  taskId: string;
  worktreePath: string;
};

function usage(): string {
  return `Usage: bun platform/dev/worktree/task-worktree-protection.ts protect --repo-root <path> --worktree <path> --branch <task/...> [--task-id <TASK_ID>] [--reason <value>]

Write or refresh the bounded local protection lease for a canonical task worktree. This lease is a deletion guard and does not define active worktree freshness.`;
}

function parseArgs(argv: string[]): CliOptions {
  const command = String(argv[0] || "").trim();
  if (command !== "protect") {
    fail(usage());
  }

  let repoRoot = "";
  let worktreePath = "";
  let branch = "";
  let taskId = "";
  let reason = "manual";

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--repo-root":
        repoRoot = String(argv[index + 1] || "").trim();
        if (!repoRoot) {
          fail("missing value for --repo-root");
        }
        index += 1;
        break;
      case "--worktree":
        worktreePath = String(argv[index + 1] || "").trim();
        if (!worktreePath) {
          fail("missing value for --worktree");
        }
        index += 1;
        break;
      case "--branch":
        branch = String(argv[index + 1] || "").trim();
        if (!branch) {
          fail("missing value for --branch");
        }
        index += 1;
        break;
      case "--task-id":
        taskId = normalizeTaskId(String(argv[index + 1] || "").trim());
        if (!taskId) {
          fail("missing value for --task-id");
        }
        index += 1;
        break;
      case "--reason":
        reason = String(argv[index + 1] || "").trim();
        if (!reason) {
          fail("missing value for --reason");
        }
        index += 1;
        break;
      case "--help":
      case "-h":
        process.stdout.write(`${usage()}\n`);
        process.exit(0);
        return {
          branch: "",
          reason: "manual",
          repoRoot: "",
          taskId: "",
          worktreePath: "",
        };
      default:
        fail(`unknown option: ${arg}`);
    }
  }

  if (!repoRoot) {
    fail("--repo-root is required");
  }
  if (!worktreePath) {
    fail("--worktree is required");
  }
  if (!branch) {
    fail("--branch is required");
  }

  return {
    branch,
    reason,
    repoRoot: canonicalPath(repoRoot),
    taskId,
    worktreePath: canonicalPath(worktreePath),
  };
}

function resolveCanonicalTaskRoot(repoRoot: string): string {
  return resolveCanonicalTaskRootFromRepoRoot(repoRoot);
}

function resolveProtectionRoot(repoRoot: string): string {
  return resolveTaskWorktreeProtectionRootFromRepoRoot(repoRoot);
}

function ensureCanonicalTaskWorktree(repoRoot: string, worktreePath: string): string {
  const canonicalRepoRoot = canonicalPath(repoRoot);
  const canonicalWorktreePath = canonicalPath(worktreePath);
  const allowedWorktreeRoot = resolveCanonicalTaskRoot(canonicalRepoRoot);
  if (!isInsidePath(canonicalWorktreePath, allowedWorktreeRoot)) {
    fail(
      `task worktree protection requires a canonical task worktree under ${allowedWorktreeRoot}; received ${canonicalWorktreePath}`
    );
  }
  if (path.dirname(canonicalWorktreePath) !== allowedWorktreeRoot) {
    fail(
      `task worktree protection requires a direct child canonical task worktree under ${allowedWorktreeRoot}; received ${canonicalWorktreePath}`
    );
  }
  return canonicalWorktreePath;
}

function resolveLeasePath(repoRoot: string, worktreePath: string): string {
  const canonicalWorktreePath = ensureCanonicalTaskWorktree(repoRoot, worktreePath);
  const worktreeHash = createHash("sha1").update(canonicalWorktreePath).digest("hex");
  return path.join(resolveProtectionRoot(repoRoot), `${worktreeHash}.json`);
}

function parseLease(rawText: string, worktreePath: string): TaskWorktreeProtectionLease | null {
  try {
    const parsed = JSON.parse(rawText) as Partial<TaskWorktreeProtectionLease>;
    if (
      parsed?.version !== 1 ||
      typeof parsed.branch !== "string" ||
      typeof parsed.taskId !== "string" ||
      typeof parsed.reason !== "string" ||
      typeof parsed.protectedUntil !== "string" ||
      typeof parsed.updatedAt !== "string" ||
      typeof parsed.worktreePath !== "string"
    ) {
      return null;
    }
    const canonicalWorktreePath = canonicalPath(worktreePath);
    if (canonicalPath(parsed.worktreePath) !== canonicalWorktreePath) {
      return null;
    }
    return {
      version: 1,
      branch: shortBranch(parsed.branch),
      taskId: normalizeTaskId(parsed.taskId),
      reason: parsed.reason.trim(),
      protectedUntil: parsed.protectedUntil,
      updatedAt: parsed.updatedAt,
      worktreePath: canonicalWorktreePath,
    };
  } catch {
    return null;
  }
}

export function readTaskWorktreeProtectionLease(
  repoRoot: string,
  worktreePath: string
): TaskWorktreeProtectionLease | null {
  const leasePath = resolveLeasePath(repoRoot, worktreePath);
  if (!existsSync(leasePath)) {
    return null;
  }
  return parseLease(readFileSync(leasePath, "utf8"), worktreePath);
}

export function isTaskWorktreeProtectionLeaseActive(
  lease: TaskWorktreeProtectionLease | null,
  nowMs = Date.now()
): boolean {
  if (!lease) {
    return false;
  }
  const protectedUntilMs = Date.parse(lease.protectedUntil);
  return Number.isFinite(protectedUntilMs) && protectedUntilMs > nowMs;
}

export function writeTaskWorktreeProtectionLease(input: {
  branch: string;
  nowMs?: number;
  reason: string;
  repoRoot: string;
  taskId?: string;
  ttlMs?: number;
  worktreePath: string;
}): TaskWorktreeProtectionLease {
  const canonicalRepoRoot = canonicalPath(input.repoRoot);
  const canonicalWorktreePath = ensureCanonicalTaskWorktree(canonicalRepoRoot, input.worktreePath);
  const branch = shortBranch(input.branch);
  if (!branch.startsWith("task/")) {
    fail(`task worktree protection requires a task/* branch; received ${branch || "(empty)"}`);
  }
  const taskId = normalizeTaskId(input.taskId || extractTaskIdFromBranch(branch) || "");
  if (!taskId) {
    fail(`failed to resolve task id from branch: ${branch}`);
  }

  const ttlMs = input.ttlMs ?? TASK_WORKTREE_PROTECTION_LEASE_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    fail(`task worktree protection ttl must be > 0; received ${ttlMs}`);
  }
  const nowMs = input.nowMs ?? Date.now();
  const lease: TaskWorktreeProtectionLease = {
    version: 1,
    branch,
    taskId,
    reason: String(input.reason || "").trim() || "manual",
    protectedUntil: new Date(nowMs + ttlMs).toISOString(),
    updatedAt: new Date(nowMs).toISOString(),
    worktreePath: canonicalWorktreePath,
  };
  const leasePath = resolveLeasePath(canonicalRepoRoot, canonicalWorktreePath);
  mkdirSync(path.dirname(leasePath), { recursive: true });
  writeFileSync(leasePath, `${JSON.stringify(lease, null, 2)}\n`, "utf8");
  return lease;
}

function main(): void {
  const cli = parseArgs(process.argv.slice(2));
  const lease = writeTaskWorktreeProtectionLease({
    branch: cli.branch,
    reason: cli.reason,
    repoRoot: cli.repoRoot,
    taskId: cli.taskId,
    worktreePath: cli.worktreePath,
  });
  process.stdout.write(
    `[task-worktree-protection] protected ${lease.worktreePath} until ${lease.protectedUntil} (${lease.reason})\n`
  );
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[task-worktree-protection] ERROR: ${(error as Error).message}\n`);
    process.exit(1);
  }
}
