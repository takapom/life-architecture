import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  canonicalPath,
  resolveTaskScopeLockRootFromRepoRoot,
} from "../../../platform/dev/worktree/worktree-topology";
import { fail, parseJson } from "../../adapters/cli";
import { normalizePathPattern } from "../issue-graph-types";
import { normalizeTaskId } from "../task-issue-guard";
import { deriveTaskScopeAdmissionClassification } from "./derivation";
import {
  collectManifestConflicts,
  renderTaskScopeConflictDiagnostic,
  type TaskScopeManifest,
} from "./manifest";
import { normalizeTaskScopeResourceClaims, resourceClaimsEqual } from "./resource-claims";
import {
  TASK_SCOPE_ADMISSION_MODES,
  TASK_SCOPE_CONFLICT_CLASSES,
  TASK_SCOPE_VERIFICATION_CLASSES,
  TASK_SCOPE_VERSION,
  type TaskScopeAdmissionMode,
  type TaskScopeLock,
} from "./types";

const LOCK_PREEMPT_SIGNAL = "SIGTERM";
const LOCK_PREEMPT_FORCE_SIGNAL = "SIGKILL";
const LOCK_PREEMPT_GRACE_MS = 5_000;
const LOCK_PREEMPT_POLL_MS = 100;

function isTaskScopeConflictClass(value: string): value is TaskScopeLock["conflictClass"] {
  return (TASK_SCOPE_CONFLICT_CLASSES as readonly string[]).includes(value);
}

function isTaskScopeVerificationClass(value: string): value is TaskScopeLock["verificationClass"] {
  return (TASK_SCOPE_VERIFICATION_CLASSES as readonly string[]).includes(value);
}

function isTaskScopeAdmissionMode(value: string): value is TaskScopeAdmissionMode {
  return (TASK_SCOPE_ADMISSION_MODES as readonly string[]).includes(value);
}

function normalizeAdmissionMode(value: unknown): TaskScopeAdmissionMode {
  const normalized = String(value || "standard")
    .trim()
    .toLowerCase();
  if (normalized === "global-exclusive") return "global-exclusive";
  if (normalized === "landing-exclusive") return "landing-exclusive";
  return "standard";
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function normalizeStringArray(
  raw: unknown,
  normalizeEntry: (value: string) => string
): string[] | null {
  if (!Array.isArray(raw)) return null;
  return [...new Set(raw.map((value) => normalizeEntry(String(value || ""))).filter(Boolean))];
}

function resolveTaskScopeLockPath(repoRoot: string, lockId: string): string {
  return path.join(resolveTaskScopeLockRootFromRepoRoot(repoRoot), `${lockId}.json`);
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function canonicalizeManifestForLock(manifest: TaskScopeManifest): TaskScopeManifest {
  const derived = deriveTaskScopeAdmissionClassification({
    allowedFiles: manifest.allowedGlobs,
    commitUnits: manifest.commitUnits || [],
  });
  const commitUnits = [
    ...new Set(
      (manifest.commitUnits || []).map((value) => String(value || "").trim()).filter(Boolean)
    ),
  ];
  const scopeGateKeys = manifest.scopeGateKeys || derived.scopeGateKeys;
  const serializedScopeKeys = manifest.serializedScopeKeys || derived.serializedScopeKeys;
  const admissionMode = normalizeAdmissionMode(manifest.admissionMode);
  const globalInvariant = String(manifest.globalInvariant || "").trim();
  const unfreezeCondition = String(manifest.unfreezeCondition || "").trim();
  if (!arraysEqual(manifest.allowedGlobs, derived.allowedGlobs)) {
    fail(`task-scope manifest drift for ${manifest.taskId}: allowedGlobs must stay canonical`);
  }
  if (manifest.ownerBucket !== derived.ownerBucket) {
    fail(`task-scope manifest drift for ${manifest.taskId}: ownerBucket must stay canonical`);
  }
  if (!arraysEqual(manifest.ownerBuckets, derived.ownerBuckets)) {
    fail(`task-scope manifest drift for ${manifest.taskId}: ownerBuckets must stay canonical`);
  }
  if (!arraysEqual(commitUnits, [...new Set(commitUnits)])) {
    fail(`task-scope manifest drift for ${manifest.taskId}: commitUnits must stay canonical`);
  }
  if (!arraysEqual(scopeGateKeys, derived.scopeGateKeys)) {
    fail(`task-scope manifest drift for ${manifest.taskId}: scopeGateKeys must stay canonical`);
  }
  if (!arraysEqual(serializedScopeKeys, derived.serializedScopeKeys)) {
    fail(
      `task-scope manifest drift for ${manifest.taskId}: serializedScopeKeys must stay canonical`
    );
  }
  if (!arraysEqual(manifest.hotRootPaths, derived.hotRootPaths)) {
    fail(`task-scope manifest drift for ${manifest.taskId}: hotRootPaths must stay canonical`);
  }
  if (manifest.touchesHotRoot !== derived.touchesHotRoot) {
    fail(`task-scope manifest drift for ${manifest.taskId}: touchesHotRoot must stay canonical`);
  }
  if (manifest.conflictClass !== derived.conflictClass) {
    fail(`task-scope manifest drift for ${manifest.taskId}: conflictClass must stay canonical`);
  }
  if (manifest.verificationClass !== derived.verificationClass) {
    fail(`task-scope manifest drift for ${manifest.taskId}: verificationClass must stay canonical`);
  }
  if (
    manifest.resourceClaims &&
    !resourceClaimsEqual(manifest.resourceClaims, derived.resourceClaims)
  ) {
    fail(`task-scope manifest drift for ${manifest.taskId}: resourceClaims must stay canonical`);
  }
  if (!isTaskScopeAdmissionMode(admissionMode)) {
    fail(`task-scope manifest drift for ${manifest.taskId}: admissionMode must stay canonical`);
  }
  if (admissionMode === "global-exclusive" && (!globalInvariant || !unfreezeCondition)) {
    fail(
      `task-scope manifest drift for ${manifest.taskId}: global-exclusive admission requires globalInvariant and unfreezeCondition`
    );
  }
  if (
    (admissionMode === "standard" || admissionMode === "landing-exclusive") &&
    (globalInvariant || unfreezeCondition)
  ) {
    fail(
      `task-scope manifest drift for ${manifest.taskId}: standard/landing-exclusive admission must not carry global-exclusive fields`
    );
  }
  return {
    ...manifest,
    allowedGlobs: derived.allowedGlobs,
    ownerBucket: derived.ownerBucket,
    ownerBuckets: derived.ownerBuckets,
    admissionMode,
    globalInvariant,
    unfreezeCondition,
    commitUnits,
    scopeGateKeys: derived.scopeGateKeys,
    serializedScopeKeys: derived.serializedScopeKeys,
    hotRootPaths: derived.hotRootPaths,
    touchesHotRoot: derived.touchesHotRoot,
    conflictClass: derived.conflictClass,
    verificationClass: derived.verificationClass,
    resourceClaims: derived.resourceClaims,
  };
}

function normalizeLock(raw: unknown): TaskScopeLock | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  if (Number(item.version || 0) !== TASK_SCOPE_VERSION) return null;
  const lockId = String(item.lockId || "").trim();
  const taskId = normalizeTaskId(String(item.taskId || "").trim());
  const issueNumber = Number(item.issueNumber || 0);
  const issueUrl = String(item.issueUrl || "").trim();
  const sessionId = String(item.sessionId || "").trim();
  const branch = String(item.branch || "").trim();
  const worktreePath = String(item.worktreePath || "").trim();
  const ownerBucket = String(item.ownerBucket || "").trim();
  const ownerBuckets = normalizeStringArray(item.ownerBuckets, (value) => value.trim());
  const allowedGlobs = normalizeStringArray(item.allowedGlobs, (value) =>
    normalizePathPattern(value)
  );
  const commitUnits = normalizeStringArray(item.commitUnits, (value) => value.trim());
  const admissionMode = normalizeAdmissionMode(item.admissionMode);
  const globalInvariant = String(item.globalInvariant || "").trim();
  const unfreezeCondition = String(item.unfreezeCondition || "").trim();
  const scopeGateKeys = normalizeStringArray(item.scopeGateKeys, (value) => value.trim());
  const serializedScopeKeys = normalizeStringArray(item.serializedScopeKeys, (value) =>
    value.trim()
  );
  const hotRootPaths = normalizeStringArray(item.hotRootPaths, (value) =>
    normalizePathPattern(value)
  );
  const conflictClass = String(item.conflictClass || "").trim();
  const verificationClass = String(item.verificationClass || "").trim();
  const resourceClaims =
    item.resourceClaims === undefined
      ? null
      : normalizeTaskScopeResourceClaims(item.resourceClaims);
  const createdAt = String(item.createdAt || "").trim();
  const updatedAt = String(item.updatedAt || "").trim();
  const pid = Number(item.pid || 0);
  if (!lockId || !taskId || !sessionId) return null;
  if (!Number.isInteger(issueNumber) || issueNumber <= 0 || !issueUrl) return null;
  if (!branch || !worktreePath || !Number.isInteger(pid) || pid <= 0) return null;
  if (!ownerBucket || !ownerBuckets || ownerBuckets.length === 0) return null;
  if (
    !allowedGlobs ||
    allowedGlobs.length === 0 ||
    !commitUnits ||
    commitUnits.length === 0 ||
    !scopeGateKeys ||
    !serializedScopeKeys ||
    !hotRootPaths
  ) {
    return null;
  }
  if (!isTaskScopeConflictClass(conflictClass)) return null;
  if (!isTaskScopeVerificationClass(verificationClass)) return null;
  if (!isTaskScopeAdmissionMode(admissionMode)) return null;
  if (!createdAt || !updatedAt) return null;
  if (admissionMode === "global-exclusive" && (!globalInvariant || !unfreezeCondition)) {
    return null;
  }
  if (
    (admissionMode === "standard" || admissionMode === "landing-exclusive") &&
    (globalInvariant || unfreezeCondition)
  ) {
    return null;
  }
  const derived = deriveTaskScopeAdmissionClassification({
    allowedFiles: allowedGlobs,
    commitUnits,
  });
  if (ownerBucket !== derived.ownerBucket) return null;
  if (!arraysEqual(ownerBuckets, derived.ownerBuckets)) return null;
  if (!arraysEqual(scopeGateKeys, derived.scopeGateKeys)) return null;
  if (!arraysEqual(serializedScopeKeys, derived.serializedScopeKeys)) return null;
  if (!arraysEqual(hotRootPaths, derived.hotRootPaths)) return null;
  if (conflictClass !== derived.conflictClass) return null;
  if (verificationClass !== derived.verificationClass) return null;
  if (resourceClaims && !resourceClaimsEqual(resourceClaims, derived.resourceClaims)) return null;
  return {
    version: TASK_SCOPE_VERSION,
    lockId,
    taskId,
    issueNumber,
    issueUrl,
    sessionId,
    branch,
    pid,
    worktreePath: canonicalPath(worktreePath),
    ownerBucket: derived.ownerBucket,
    ownerBuckets: derived.ownerBuckets,
    allowedGlobs: derived.allowedGlobs,
    commitUnits: [...new Set(commitUnits)],
    admissionMode,
    globalInvariant,
    unfreezeCondition,
    scopeGateKeys: derived.scopeGateKeys,
    serializedScopeKeys: derived.serializedScopeKeys,
    hotRootPaths: derived.hotRootPaths,
    conflictClass: derived.conflictClass,
    verificationClass: derived.verificationClass,
    resourceClaims: derived.resourceClaims,
    createdAt,
    updatedAt,
  };
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function manifestFromLock(lock: TaskScopeLock): TaskScopeManifest {
  return {
    version: TASK_SCOPE_VERSION,
    taskId: lock.taskId,
    issueNumber: lock.issueNumber,
    issueUrl: lock.issueUrl,
    title: lock.taskId,
    ownerBucket: lock.ownerBucket,
    ownerBuckets: lock.ownerBuckets,
    allowedGlobs: lock.allowedGlobs,
    commitUnits: lock.commitUnits,
    admissionMode: lock.admissionMode,
    globalInvariant: lock.globalInvariant,
    unfreezeCondition: lock.unfreezeCondition,
    scopeGateKeys: lock.scopeGateKeys,
    serializedScopeKeys: lock.serializedScopeKeys,
    hotRootPaths: lock.hotRootPaths,
    touchesHotRoot: lock.hotRootPaths.length > 0,
    conflictClass: lock.conflictClass,
    verificationClass: lock.verificationClass,
    resourceClaims: lock.resourceClaims || [],
    dependencyEdges: [],
    acceptanceChecks: [],
    tests: [],
    createdAt: lock.createdAt,
    updatedAt: lock.updatedAt,
  };
}

function buildLockId(taskId: string, sessionId: string): string {
  return createHash("sha1").update(`${taskId}\u0000${sessionId}`).digest("hex");
}

export function listActiveTaskScopeLocks(repoRoot: string): TaskScopeLock[] {
  const lockRoot = resolveTaskScopeLockRootFromRepoRoot(repoRoot);
  if (!existsSync(lockRoot)) return [];

  const active: TaskScopeLock[] = [];
  for (const entry of readdirSync(lockRoot)) {
    if (!entry.endsWith(".json")) continue;
    const lockPath = path.join(lockRoot, entry);
    const lock = normalizeLock(parseJson(readFileSync(lockPath, "utf8"), lockPath));
    if (!lock || !isPidAlive(lock.pid)) {
      rmSync(lockPath, { force: true });
      continue;
    }
    active.push(lock);
  }
  return active.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function terminateTaskScopeLockHolder(lock: TaskScopeLock): void {
  if (!isPidAlive(lock.pid)) {
    return;
  }
  try {
    process.kill(lock.pid, LOCK_PREEMPT_SIGNAL);
  } catch {
    return;
  }

  const deadline = Date.now() + LOCK_PREEMPT_GRACE_MS;
  while (Date.now() < deadline) {
    if (!isPidAlive(lock.pid)) {
      return;
    }
    sleepSync(LOCK_PREEMPT_POLL_MS);
  }

  if (!isPidAlive(lock.pid)) {
    return;
  }
  try {
    process.kill(lock.pid, LOCK_PREEMPT_FORCE_SIGNAL);
  } catch {
    return;
  }

  const forceDeadline = Date.now() + LOCK_PREEMPT_GRACE_MS;
  while (Date.now() < forceDeadline) {
    if (!isPidAlive(lock.pid)) {
      return;
    }
    sleepSync(LOCK_PREEMPT_POLL_MS);
  }

  if (isPidAlive(lock.pid)) {
    fail(
      `failed to preempt task-scope lock holder ${lock.taskId} (pid=${lock.pid}) for global-exclusive admission`
    );
  }
}

function preemptStandardTaskScopeLocksForGlobalExclusive(options: {
  manifest: TaskScopeManifest;
  repoRoot: string;
}): void {
  if (normalizeAdmissionMode(options.manifest.admissionMode) !== "global-exclusive") {
    return;
  }

  const activeLocks = listActiveTaskScopeLocks(options.repoRoot);
  const blockingGlobalExclusive = activeLocks.find(
    (lock) =>
      lock.taskId !== options.manifest.taskId &&
      normalizeAdmissionMode(lock.admissionMode) === "global-exclusive"
  );
  if (blockingGlobalExclusive) {
    return;
  }

  for (const lock of activeLocks) {
    if (lock.taskId === options.manifest.taskId) continue;
    if (normalizeAdmissionMode(lock.admissionMode) === "global-exclusive") continue;
    terminateTaskScopeLockHolder(lock);
  }

  listActiveTaskScopeLocks(options.repoRoot);
}

export function acquireTaskScopeLock(options: {
  branch: string;
  manifest: TaskScopeManifest;
  repoRoot: string;
  sessionId: string;
  worktreePath: string;
}): TaskScopeLock {
  const canonicalManifest = canonicalizeManifestForLock(options.manifest);
  preemptStandardTaskScopeLocksForGlobalExclusive({
    manifest: canonicalManifest,
    repoRoot: options.repoRoot,
  });
  const conflicts = collectTaskScopeLockConflicts({
    manifest: canonicalManifest,
    repoRoot: options.repoRoot,
  });
  if (conflicts.length > 0) {
    fail(
      [
        `task-scope admission denied for ${canonicalManifest.taskId}.`,
        ...conflicts.map((conflict) => `  - ${renderTaskScopeConflictDiagnostic(conflict)}`),
      ].join("\n")
    );
  }

  const now = new Date().toISOString();
  const lock: TaskScopeLock = {
    version: TASK_SCOPE_VERSION,
    lockId: buildLockId(canonicalManifest.taskId, options.sessionId),
    taskId: canonicalManifest.taskId,
    issueNumber: canonicalManifest.issueNumber,
    issueUrl: canonicalManifest.issueUrl,
    sessionId: options.sessionId,
    branch: options.branch,
    pid: process.pid,
    worktreePath: canonicalPath(options.worktreePath),
    ownerBucket: canonicalManifest.ownerBucket,
    ownerBuckets: canonicalManifest.ownerBuckets,
    allowedGlobs: canonicalManifest.allowedGlobs,
    commitUnits: canonicalManifest.commitUnits,
    admissionMode: canonicalManifest.admissionMode,
    globalInvariant: canonicalManifest.globalInvariant,
    unfreezeCondition: canonicalManifest.unfreezeCondition,
    scopeGateKeys: canonicalManifest.scopeGateKeys,
    serializedScopeKeys: canonicalManifest.serializedScopeKeys,
    hotRootPaths: canonicalManifest.hotRootPaths,
    conflictClass: canonicalManifest.conflictClass,
    verificationClass: canonicalManifest.verificationClass,
    resourceClaims: canonicalManifest.resourceClaims || [],
    createdAt: now,
    updatedAt: now,
  };
  const lockPath = resolveTaskScopeLockPath(options.repoRoot, lock.lockId);
  mkdirSync(path.dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  return lock;
}

export function collectTaskScopeLockConflicts(options: {
  ignoreTaskId?: string;
  manifest: TaskScopeManifest;
  repoRoot: string;
}): ReturnType<typeof collectManifestConflicts> {
  const canonicalManifest = canonicalizeManifestForLock(options.manifest);
  const activeLocks = listActiveTaskScopeLocks(options.repoRoot);
  return collectManifestConflicts(
    canonicalManifest,
    activeLocks
      .map((lock) => manifestFromLock(lock))
      .filter((manifest) => manifest.taskId !== normalizeTaskId(options.ignoreTaskId || ""))
  );
}

export function releaseTaskScopeLock(repoRoot: string, lockId: string): void {
  const lockPath = resolveTaskScopeLockPath(repoRoot, lockId);
  if (existsSync(lockPath)) {
    unlinkSync(lockPath);
  }
}
