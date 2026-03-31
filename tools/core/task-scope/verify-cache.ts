import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { resolveVerifyCacheRootFromRepoRoot } from "../../../platform/dev/worktree/worktree-topology";
import { parseJson } from "../../adapters/cli";
import { normalizePathPattern } from "../issue-graph-types";
import { normalizeTaskId } from "../task-issue-guard";
import { normalizeTaskScopeVerificationCommands } from "./command-normalization";
import {
  TASK_SCOPE_VERIFICATION_CLASSES,
  type TaskScopeManifest,
  type TaskScopeVerificationClass,
  VERIFY_CACHE_VERSION,
  type VerifyCacheEntry,
  type VerifyCacheStatusReason,
} from "./types";

function isTaskScopeVerificationClass(value: string): value is TaskScopeVerificationClass {
  return (TASK_SCOPE_VERIFICATION_CLASSES as readonly string[]).includes(value);
}

type VerifyFingerprintInputs = {
  verificationClass: TaskScopeVerificationClass;
  mergeBase: string | null;
  manifestDigest: string;
  commandPlanDigest: string;
  changedFiles: string[];
  commands: string[];
  lockfileHash: string;
};

export type VerifyCacheStatus = {
  entry: VerifyCacheEntry | null;
  fingerprint: string;
  reason: VerifyCacheStatusReason;
  detail: string;
};

function normalizeStringArray(
  raw: unknown,
  normalizeEntry: (value: string) => string
): string[] | null {
  if (!Array.isArray(raw)) return null;
  return [...new Set(raw.map((value) => normalizeEntry(String(value || ""))).filter(Boolean))];
}

function resolveVerifyCachePath(repoRoot: string, fingerprint: string): string {
  return path.join(resolveVerifyCacheRootFromRepoRoot(repoRoot), `${fingerprint}.json`);
}

function readHashForFile(filePath: string): string {
  if (!existsSync(filePath)) return "";
  return createHash("sha1").update(readFileSync(filePath)).digest("hex");
}

function hashPayload(value: unknown): string {
  return createHash("sha1").update(JSON.stringify(value)).digest("hex");
}

function normalizeChangedFiles(changedFiles: string[]): string[] {
  return [
    ...new Set(changedFiles.map((filePath) => normalizePathPattern(filePath)).filter(Boolean)),
  ].sort();
}

function normalizeCommands(commands: string[]): string[] {
  return [
    ...new Set(
      normalizeTaskScopeVerificationCommands(commands)
        .map((command) => String(command || "").trim())
        .filter(Boolean)
    ),
  ];
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function serializeVerifyFingerprintInputs(
  inputs: VerifyFingerprintInputs
): VerifyFingerprintInputs {
  return {
    verificationClass: inputs.verificationClass,
    mergeBase: inputs.mergeBase,
    manifestDigest: inputs.manifestDigest,
    commandPlanDigest: inputs.commandPlanDigest,
    changedFiles: inputs.changedFiles,
    commands: inputs.commands,
    lockfileHash: inputs.lockfileHash,
  };
}

export function buildVerifyManifestDigest(taskScope: TaskScopeManifest): string {
  return hashPayload({
    ownerBucket: taskScope.ownerBucket,
    ownerBuckets: taskScope.ownerBuckets,
    allowedGlobs: taskScope.allowedGlobs,
    hotRootPaths: taskScope.hotRootPaths,
    touchesHotRoot: taskScope.touchesHotRoot,
    conflictClass: taskScope.conflictClass,
    verificationClass: taskScope.verificationClass,
  });
}

export function buildVerifyCommandPlanDigest(commands: string[]): string {
  return hashPayload(normalizeCommands(commands));
}

function resolveVerifyFingerprintInputs(options: {
  changedFiles: string[];
  commands: string[];
  mergeBase: string | null;
  repoRoot: string;
  taskScope: TaskScopeManifest;
}): VerifyFingerprintInputs {
  return {
    changedFiles: normalizeChangedFiles(options.changedFiles),
    commands: normalizeCommands(options.commands),
    lockfileHash: readHashForFile(path.join(options.repoRoot, "bun.lock")),
    mergeBase: options.mergeBase || null,
    verificationClass: options.taskScope.verificationClass,
    manifestDigest: buildVerifyManifestDigest(options.taskScope),
    commandPlanDigest: buildVerifyCommandPlanDigest(options.commands),
  };
}

function buildVerifyFingerprintFromInputs(inputs: VerifyFingerprintInputs): string {
  return hashPayload(serializeVerifyFingerprintInputs(inputs));
}

function normalizeVerifyCacheEntry(raw: unknown): VerifyCacheEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  if (Number(item.version || 0) !== VERIFY_CACHE_VERSION) return null;
  const fingerprint = String(item.fingerprint || "").trim();
  const taskId = normalizeTaskId(String(item.taskId || "").trim());
  const verificationClass = String(item.verificationClass || "").trim();
  const changedFiles = normalizeStringArray(item.changedFiles, (value) =>
    normalizePathPattern(value)
  );
  const commands = normalizeStringArray(item.commands, (value) => value.trim());
  const manifestDigest = String(item.manifestDigest || "").trim();
  const commandPlanDigest = String(item.commandPlanDigest || "").trim();
  const lockfileHash = String(item.lockfileHash || "").trim();
  const createdAt = String(item.createdAt || "").trim();
  if (!fingerprint || !taskId) return null;
  if (!isTaskScopeVerificationClass(verificationClass)) return null;
  if (!changedFiles || changedFiles.length === 0) return null;
  if (!commands || commands.length === 0) return null;
  if (!manifestDigest || !commandPlanDigest) return null;
  if (!createdAt) return null;
  const inputs: VerifyFingerprintInputs = {
    verificationClass,
    mergeBase: String(item.mergeBase || "").trim() || null,
    manifestDigest,
    commandPlanDigest,
    changedFiles,
    commands,
    lockfileHash,
  };
  if (fingerprint !== buildVerifyFingerprintFromInputs(inputs)) return null;
  return {
    version: VERIFY_CACHE_VERSION,
    fingerprint,
    taskId,
    verificationClass,
    mergeBase: inputs.mergeBase,
    manifestDigest,
    commandPlanDigest,
    changedFiles,
    commands,
    lockfileHash,
    createdAt,
  };
}

export function buildVerifyFingerprint(options: {
  changedFiles: string[];
  commands: string[];
  mergeBase: string | null;
  repoRoot: string;
  taskScope: TaskScopeManifest;
}): string {
  const payload = resolveVerifyFingerprintInputs(options);
  return buildVerifyFingerprintFromInputs(payload);
}

export function readVerifyCacheEntry(
  repoRoot: string,
  fingerprint: string
): VerifyCacheEntry | null {
  const cachePath = resolveVerifyCachePath(repoRoot, fingerprint);
  if (!existsSync(cachePath)) return null;
  return normalizeVerifyCacheEntry(parseJson(readFileSync(cachePath, "utf8"), cachePath));
}

export function listVerifyCacheEntries(repoRoot: string): VerifyCacheEntry[] {
  const cacheRoot = resolveVerifyCacheRootFromRepoRoot(repoRoot);
  if (!existsSync(cacheRoot)) return [];

  return readdirSync(cacheRoot)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => {
      const cachePath = path.join(cacheRoot, entry);
      return normalizeVerifyCacheEntry(parseJson(readFileSync(cachePath, "utf8"), cachePath));
    })
    .filter((entry): entry is VerifyCacheEntry => entry !== null)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function writeVerifyCacheEntry(options: {
  commands: string[];
  fingerprint: string;
  mergeBase: string | null;
  repoRoot: string;
  changedFiles: string[];
  taskScope: TaskScopeManifest;
}): string {
  const cachePath = resolveVerifyCachePath(options.repoRoot, options.fingerprint);
  mkdirSync(path.dirname(cachePath), { recursive: true });
  const inputs = resolveVerifyFingerprintInputs(options);
  const fingerprint = buildVerifyFingerprintFromInputs(inputs);
  if (options.fingerprint !== fingerprint) {
    throw new Error(
      `verify-cache fingerprint drift for ${normalizeTaskId(options.taskScope.taskId)}: entry fingerprint must stay canonical`
    );
  }
  const entry: VerifyCacheEntry = {
    version: VERIFY_CACHE_VERSION,
    fingerprint,
    taskId: normalizeTaskId(options.taskScope.taskId),
    verificationClass: inputs.verificationClass,
    mergeBase: inputs.mergeBase,
    manifestDigest: inputs.manifestDigest,
    commandPlanDigest: inputs.commandPlanDigest,
    changedFiles: inputs.changedFiles,
    commands: inputs.commands,
    lockfileHash: inputs.lockfileHash,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(cachePath, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
  return cachePath;
}

export function resolveVerifyCacheStatus(options: {
  changedFiles: string[];
  commands: string[];
  mergeBase: string | null;
  repoRoot: string;
  taskScope: TaskScopeManifest;
}): VerifyCacheStatus {
  const inputs = resolveVerifyFingerprintInputs(options);
  const fingerprint = buildVerifyFingerprintFromInputs(inputs);
  const exact = readVerifyCacheEntry(options.repoRoot, fingerprint);
  if (exact) {
    return {
      entry: exact,
      fingerprint,
      reason: "hit",
      detail: `reused ${exact.fingerprint} for ${exact.taskId}`,
    };
  }

  const taskEntries = listVerifyCacheEntries(options.repoRoot).filter(
    (entry) => entry.verificationClass === inputs.verificationClass
  );
  if (taskEntries.length === 0) {
    return {
      entry: null,
      fingerprint,
      reason: "cache-empty",
      detail: `no cached verification entry exists for ${normalizeTaskId(options.taskScope.taskId)}`,
    };
  }

  const sameManifest = taskEntries.filter(
    (entry) => entry.manifestDigest === inputs.manifestDigest
  );
  if (sameManifest.length === 0) {
    return {
      entry: null,
      fingerprint,
      reason: "manifest-drift",
      detail: `cached entries exist, but the canonical scope manifest digest changed for ${normalizeTaskId(options.taskScope.taskId)}`,
    };
  }

  const sameCommandPlan = sameManifest.filter(
    (entry) => entry.commandPlanDigest === inputs.commandPlanDigest
  );
  if (sameCommandPlan.length === 0) {
    return {
      entry: null,
      fingerprint,
      reason: "command-plan-drift",
      detail: `cached entries for ${normalizeTaskId(options.taskScope.taskId)} do not match the current command plan`,
    };
  }

  const sameChangedFiles = sameCommandPlan.filter((entry) =>
    arraysEqual(entry.changedFiles, inputs.changedFiles)
  );
  if (sameChangedFiles.length === 0) {
    return {
      entry: null,
      fingerprint,
      reason: "changed-files-drift",
      detail: `cached entries for ${normalizeTaskId(options.taskScope.taskId)} do not match the current changed-file set`,
    };
  }

  const sameMergeBase = sameChangedFiles.filter((entry) => entry.mergeBase === inputs.mergeBase);
  if (sameMergeBase.length === 0) {
    return {
      entry: null,
      fingerprint,
      reason: "merge-base-drift",
      detail: `cached entries for ${normalizeTaskId(options.taskScope.taskId)} were recorded against a different merge base`,
    };
  }

  return {
    entry: null,
    fingerprint,
    reason: "lockfile-drift",
    detail: `cached entries for ${normalizeTaskId(options.taskScope.taskId)} were recorded with a different root lockfile hash`,
  };
}
