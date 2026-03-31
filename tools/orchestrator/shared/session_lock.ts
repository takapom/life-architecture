import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveSessionId } from "./runtime_policy";
import { resolveSharedRuntimePaths } from "./shared_runtime";

export const SESSION_LOCK_SCHEMA_VERSION = 1;

export type SessionLockRecord = {
  schema_version: 1;
  session_id: string;
  state_dir: string;
  lock_token: string;
  owner_label: string;
  pid: number;
  hostname: string;
  created_at: string;
  updated_at: string;
};

export type AcquireSessionLockResult =
  | {
      acquired: true;
      lockPath: string;
      lock: SessionLockRecord;
    }
  | {
      acquired: false;
      reason: "already_locked";
      lockPath: string;
      existingLock: SessionLockRecord | null;
      detail: string;
    };

type BuildSessionLockRecordOptions = {
  stateDir: string;
  sessionId: string;
  lockToken?: string;
  ownerLabel: string;
  pid?: number;
  hostname?: string;
  now?: string;
};

type RefreshSessionLockOptions = {
  stateDir: string;
  lockToken: string;
  now?: string;
};

type ReleaseSessionLockOptions = {
  stateDir: string;
  lockToken: string;
};

type JsonObject = Record<string, unknown>;

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireText(value: unknown, label: string): string {
  const text = String(value || "").trim();
  if (!text) {
    throw new Error(`session lock ${label} is required`);
  }
  return text;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  throw new Error(`session lock ${label} must be a non-negative integer`);
}

function isErrnoException(value: unknown): value is NodeJS.ErrnoException {
  return Boolean(value) && typeof value === "object" && "code" in value;
}

function parseSessionLockRecord(raw: unknown): SessionLockRecord {
  if (!isObject(raw)) {
    throw new Error("session lock must be a JSON object");
  }

  const schemaVersion = Number(raw.schema_version || 0);
  if (schemaVersion !== SESSION_LOCK_SCHEMA_VERSION) {
    throw new Error(`session lock schema_version must be ${SESSION_LOCK_SCHEMA_VERSION}`);
  }

  return {
    schema_version: SESSION_LOCK_SCHEMA_VERSION,
    session_id: resolveSessionId(requireText(raw.session_id, "session_id"), {
      requiredMessage: "session lock session_id is required",
    }),
    state_dir: path.resolve(requireText(raw.state_dir, "state_dir")),
    lock_token: requireText(raw.lock_token, "lock_token"),
    owner_label: requireText(raw.owner_label, "owner_label"),
    pid: requireNonNegativeInteger(raw.pid, "pid"),
    hostname: requireText(raw.hostname, "hostname"),
    created_at: requireText(raw.created_at, "created_at"),
    updated_at: requireText(raw.updated_at, "updated_at"),
  };
}

function writeSessionLockRecord(filePath: string, lock: SessionLockRecord): void {
  writeFileSync(filePath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
}

function readSessionLockRecord(filePath: string): SessionLockRecord {
  return parseSessionLockRecord(JSON.parse(readFileSync(filePath, "utf8")) as unknown);
}

function assertLockOwnership(lock: SessionLockRecord, lockToken: string): void {
  if (lock.lock_token !== lockToken) {
    throw new Error(`session lock token mismatch: ${lock.state_dir}`);
  }
}

export function buildSessionLockToken(): string {
  return randomUUID();
}

export function buildSessionLockRecord(options: BuildSessionLockRecordOptions): SessionLockRecord {
  const stateDir = path.resolve(options.stateDir);
  const sessionId = resolveSessionId(options.sessionId, {
    requiredMessage: "session lock session_id is required",
  });
  const ownerLabel = String(options.ownerLabel || "").trim();
  if (!ownerLabel) {
    throw new Error("session lock owner_label is required");
  }

  const timestamp = String(options.now || "").trim() || nowIso();
  const lockToken = String(options.lockToken || "").trim() || buildSessionLockToken();

  return {
    schema_version: SESSION_LOCK_SCHEMA_VERSION,
    session_id: sessionId,
    state_dir: stateDir,
    lock_token: lockToken,
    owner_label: ownerLabel,
    pid: options.pid ?? process.pid,
    hostname: String(options.hostname || "").trim() || os.hostname(),
    created_at: timestamp,
    updated_at: timestamp,
  };
}

export function readSessionLock(stateDir: string): SessionLockRecord | null {
  const filePath = resolveSharedRuntimePaths(stateDir).sessionLockJson;
  if (!existsSync(filePath)) {
    return null;
  }
  return readSessionLockRecord(filePath);
}

export function acquireSessionLock(
  options: BuildSessionLockRecordOptions
): AcquireSessionLockResult {
  const paths = resolveSharedRuntimePaths(options.stateDir);
  const lock = buildSessionLockRecord(options);

  mkdirSync(paths.stateDir, { recursive: true });

  let fileDescriptor: number | null = null;
  try {
    fileDescriptor = openSync(paths.sessionLockJson, "wx", 0o600);
    writeFileSync(fileDescriptor, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
    return {
      acquired: true,
      lockPath: paths.sessionLockJson,
      lock,
    };
  } catch (error) {
    if (fileDescriptor !== null) {
      closeSync(fileDescriptor);
      fileDescriptor = null;
      try {
        unlinkSync(paths.sessionLockJson);
      } catch {
        // Best effort cleanup after a partial write.
      }
    }

    if (isErrnoException(error) && error.code === "EEXIST") {
      try {
        const existingLock = readSessionLockRecord(paths.sessionLockJson);
        return {
          acquired: false,
          reason: "already_locked",
          lockPath: paths.sessionLockJson,
          existingLock,
          detail: `session lock already held by ${existingLock.owner_label}`,
        };
      } catch (readError) {
        const detail =
          readError instanceof Error ? readError.message : "unknown session lock parse failure";
        return {
          acquired: false,
          reason: "already_locked",
          lockPath: paths.sessionLockJson,
          existingLock: null,
          detail: `session lock already exists but is invalid: ${detail}`,
        };
      }
    }

    throw error;
  } finally {
    if (fileDescriptor !== null) {
      closeSync(fileDescriptor);
    }
  }
}

export function refreshSessionLock(options: RefreshSessionLockOptions): SessionLockRecord {
  const paths = resolveSharedRuntimePaths(options.stateDir);
  const existing = readSessionLock(options.stateDir);
  if (!existing) {
    throw new Error(`session lock not found: ${paths.sessionLockJson}`);
  }

  assertLockOwnership(existing, options.lockToken);

  const refreshed: SessionLockRecord = {
    ...existing,
    updated_at: String(options.now || "").trim() || nowIso(),
  };
  writeSessionLockRecord(paths.sessionLockJson, refreshed);
  return refreshed;
}

export function releaseSessionLock(options: ReleaseSessionLockOptions): SessionLockRecord {
  const paths = resolveSharedRuntimePaths(options.stateDir);
  const existing = readSessionLock(options.stateDir);
  if (!existing) {
    throw new Error(`session lock not found: ${paths.sessionLockJson}`);
  }

  assertLockOwnership(existing, options.lockToken);
  unlinkSync(paths.sessionLockJson);
  return existing;
}
