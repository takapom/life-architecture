import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";

import { resolveSessionId } from "./runtime_policy";
import { resolveSharedRuntimePaths } from "./shared_runtime";

export const RUNTIME_EVENT_LOG_SCHEMA_VERSION = 1;

type JsonObject = Record<string, unknown>;

export type RuntimeEventRecord = {
  schema_version: 1;
  session_id: string;
  sequence: number;
  recorded_at: string;
  event_type: string;
  payload: JsonObject;
};

type AppendRuntimeEventOptions = {
  stateDir: string;
  sessionId: string;
  eventType: string;
  payload?: JsonObject;
  recordedAt?: string;
};

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireText(value: unknown, label: string): string {
  const text = String(value || "").trim();
  if (!text) {
    throw new Error(`runtime event ${label} is required`);
  }
  return text;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  throw new Error(`runtime event ${label} must be a positive integer`);
}

function parseRuntimeEventRecord(raw: unknown): RuntimeEventRecord {
  if (!isObject(raw)) {
    throw new Error("runtime event must be a JSON object");
  }

  const schemaVersion = Number(raw.schema_version || 0);
  if (schemaVersion !== RUNTIME_EVENT_LOG_SCHEMA_VERSION) {
    throw new Error(`runtime event schema_version must be ${RUNTIME_EVENT_LOG_SCHEMA_VERSION}`);
  }

  const payload = raw.payload;
  if (!isObject(payload)) {
    throw new Error("runtime event payload must be a JSON object");
  }

  return {
    schema_version: RUNTIME_EVENT_LOG_SCHEMA_VERSION,
    session_id: resolveSessionId(requireText(raw.session_id, "session_id"), {
      requiredMessage: "runtime event session_id is required",
    }),
    sequence: requirePositiveInteger(raw.sequence, "sequence"),
    recorded_at: requireText(raw.recorded_at, "recorded_at"),
    event_type: requireText(raw.event_type, "event_type"),
    payload,
  };
}

export function readRuntimeEvents(stateDir: string): RuntimeEventRecord[] {
  const logPath = resolveSharedRuntimePaths(stateDir).eventLogNdjson;
  if (!existsSync(logPath)) {
    return [];
  }

  const raw = readFileSync(logPath, "utf8");
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const events: RuntimeEventRecord[] = [];

  let previousSequence = 0;
  let expectedSessionId = "";
  for (const [index, line] of lines.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error) {
      const detail = error instanceof Error ? error.message : "invalid JSON";
      throw new Error(`runtime event log line ${index + 1} is invalid JSON: ${detail}`);
    }

    const event = parseRuntimeEventRecord(parsed);
    if (index === 0 && event.sequence !== 1) {
      throw new Error(`runtime event log must start at sequence 1: received ${event.sequence}`);
    }
    if (previousSequence > 0 && event.sequence !== previousSequence + 1) {
      throw new Error(
        `runtime event log sequence gap at line ${index + 1}: expected ${previousSequence + 1}, received ${event.sequence}`
      );
    }
    if (expectedSessionId && event.session_id !== expectedSessionId) {
      throw new Error(
        `runtime event log session mismatch at line ${index + 1}: expected ${expectedSessionId}, received ${event.session_id}`
      );
    }

    previousSequence = event.sequence;
    expectedSessionId = expectedSessionId || event.session_id;
    events.push(event);
  }

  return events;
}

export function readLastRuntimeEvent(stateDir: string): RuntimeEventRecord | null {
  const events = readRuntimeEvents(stateDir);
  return events.length > 0 ? events[events.length - 1] || null : null;
}

export function appendRuntimeEvent(options: AppendRuntimeEventOptions): RuntimeEventRecord {
  const paths = resolveSharedRuntimePaths(options.stateDir);
  const previous = readLastRuntimeEvent(options.stateDir);
  const payload = options.payload ?? {};
  if (!isObject(payload)) {
    throw new Error("runtime event payload must be a JSON object");
  }

  const event: RuntimeEventRecord = {
    schema_version: RUNTIME_EVENT_LOG_SCHEMA_VERSION,
    session_id: resolveSessionId(options.sessionId, {
      requiredMessage: "runtime event session_id is required",
    }),
    sequence: previous ? previous.sequence + 1 : 1,
    recorded_at: String(options.recordedAt || "").trim() || nowIso(),
    event_type: requireText(options.eventType, "event_type"),
    payload,
  };

  if (previous && previous.session_id !== event.session_id) {
    throw new Error(
      `runtime event log session mismatch: expected ${previous.session_id}, received ${event.session_id}`
    );
  }

  // Sequence allocation assumes a single writer guarded by the session lock.
  mkdirSync(paths.stateDir, { recursive: true });
  appendFileSync(paths.eventLogNdjson, `${JSON.stringify(event)}\n`, "utf8");
  return event;
}
