import {
  appendRuntimeEvent,
  type RuntimeEventRecord,
  readLastRuntimeEvent,
  readRuntimeEvents,
} from "./runtime_event_log";
import { resolveSessionId } from "./runtime_policy";
import {
  acquireSessionLock,
  readSessionLock,
  releaseSessionLock,
  type SessionLockRecord,
} from "./session_lock";
import { readSessionArtifactSnapshot } from "./session_state";

export const OPERATOR_COMMAND_EVENT_TYPES = {
  started: "operator.command.started",
  completed: "operator.command.completed",
  failed: "operator.command.failed",
} as const;

export const OPERATOR_LOCK_EVENT_TYPES = {
  acquired: "operator.lock.acquired",
  released: "operator.lock.released",
} as const;

export type OperatorLifecycleCommand = "start" | "resume" | "close";
export type OperatorLifecycleCommandStage = keyof typeof OPERATOR_COMMAND_EVENT_TYPES;
export type RuntimeLifecycleStatus = "not_started" | "active" | "recoverable" | "closed";

export type RuntimeLifecycleCommandRecord = {
  command: OperatorLifecycleCommand;
  stage: OperatorLifecycleCommandStage;
  recorded_at: string;
  detail: string;
  duration_ms?: number;
  delegated_script?: string;
};

export type RuntimeLifecycleProjection = {
  session_id: string;
  status: RuntimeLifecycleStatus;
  lock: SessionLockRecord | null;
  last_event: RuntimeEventRecord | null;
  last_command: RuntimeLifecycleCommandRecord | null;
  has_runtime_events: boolean;
  has_session_artifacts: boolean;
  closeout_present: boolean;
};

type SessionLockScopeOptions = {
  stateDir: string;
  sessionId: string;
  ownerLabel: string;
};

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isOperatorLifecycleCommand(value: unknown): value is OperatorLifecycleCommand {
  return value === "start" || value === "resume" || value === "close";
}

function resolveCommandStage(eventType: string): OperatorLifecycleCommandStage | null {
  switch (eventType) {
    case OPERATOR_COMMAND_EVENT_TYPES.started:
      return "started";
    case OPERATOR_COMMAND_EVENT_TYPES.completed:
      return "completed";
    case OPERATOR_COMMAND_EVENT_TYPES.failed:
      return "failed";
    default:
      return null;
  }
}

function readLastCommand(events: RuntimeEventRecord[]): RuntimeLifecycleCommandRecord | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const stage = resolveCommandStage(event?.event_type || "");
    if (!event || !stage) continue;
    const payload = isObject(event.payload) ? event.payload : {};
    const command = payload.command;
    if (!isOperatorLifecycleCommand(command)) continue;
    return {
      command,
      stage,
      recorded_at: event.recorded_at,
      detail: String(payload.detail || payload.error_message || "").trim(),
      duration_ms:
        typeof payload.duration_ms === "number" && Number.isInteger(payload.duration_ms)
          ? payload.duration_ms
          : undefined,
      delegated_script: String(payload.delegated_script || "").trim() || undefined,
    };
  }
  return null;
}

export function appendOperatorCommandEvent(options: {
  stateDir: string;
  sessionId: string;
  command: OperatorLifecycleCommand;
  stage: OperatorLifecycleCommandStage;
  delegatedScript?: string;
  detail?: string;
  durationMs?: number;
}): RuntimeEventRecord {
  const eventType = OPERATOR_COMMAND_EVENT_TYPES[options.stage];
  const payload: JsonObject = {
    command: options.command,
  };
  const delegatedScript = String(options.delegatedScript || "").trim();
  if (delegatedScript) {
    payload.delegated_script = delegatedScript;
  }
  const detail = String(options.detail || "").trim();
  if (detail) {
    payload.detail = detail;
    if (options.stage === "failed") {
      payload.error_message = detail;
    }
  }
  if (typeof options.durationMs === "number" && Number.isInteger(options.durationMs)) {
    payload.duration_ms = options.durationMs;
  }
  return appendRuntimeEvent({
    stateDir: options.stateDir,
    sessionId: options.sessionId,
    eventType,
    payload,
  });
}

export function appendOperatorLockEvent(options: {
  stateDir: string;
  sessionId: string;
  stage: keyof typeof OPERATOR_LOCK_EVENT_TYPES;
  command: OperatorLifecycleCommand;
  lock: SessionLockRecord;
}): RuntimeEventRecord {
  return appendRuntimeEvent({
    stateDir: options.stateDir,
    sessionId: options.sessionId,
    eventType: OPERATOR_LOCK_EVENT_TYPES[options.stage],
    payload: {
      command: options.command,
      owner_label: options.lock.owner_label,
      lock_token: options.lock.lock_token,
      pid: options.lock.pid,
      hostname: options.lock.hostname,
    },
  });
}

export function acquireSessionWriterLock(options: SessionLockScopeOptions): SessionLockRecord {
  const result = acquireSessionLock({
    stateDir: options.stateDir,
    sessionId: options.sessionId,
    ownerLabel: options.ownerLabel,
  });
  if (!result.acquired) {
    throw new Error(
      `session ${options.sessionId} is already locked: ${result.detail} (${result.lockPath})`
    );
  }
  return result.lock;
}

export function withSessionWriterLock<T>(
  options: SessionLockScopeOptions,
  run: (lock: SessionLockRecord) => T
): T {
  const lock = acquireSessionWriterLock(options);
  try {
    return run(lock);
  } finally {
    releaseSessionLock({
      stateDir: options.stateDir,
      lockToken: lock.lock_token,
    });
  }
}

export async function withSessionWriterLockAsync<T>(
  options: SessionLockScopeOptions,
  run: (lock: SessionLockRecord) => Promise<T>
): Promise<T> {
  const lock = acquireSessionWriterLock(options);
  try {
    return await run(lock);
  } finally {
    releaseSessionLock({
      stateDir: options.stateDir,
      lockToken: lock.lock_token,
    });
  }
}

export function summarizeRuntimeLifecycle(options: {
  stateDir: string;
  sessionId: string;
}): RuntimeLifecycleProjection {
  const sessionId = resolveSessionId(options.sessionId, {
    requiredMessage: "runtime lifecycle session_id is required",
    normalizeCase: true,
  });
  const snapshot = readSessionArtifactSnapshot(options.stateDir);
  const events = readRuntimeEvents(options.stateDir);
  const lock = readSessionLock(options.stateDir);
  const lastEvent =
    events.length > 0 ? events[events.length - 1] || null : readLastRuntimeEvent(options.stateDir);
  const closeoutPresent = snapshot.closeout_summary !== null;
  const hasSessionArtifacts = snapshot.has_session_artifacts;
  const lastCommand = readLastCommand(events);

  let status: RuntimeLifecycleStatus = "not_started";
  if (closeoutPresent) {
    status = "closed";
  } else if (lock) {
    status = "active";
  } else if (events.length > 0 || hasSessionArtifacts) {
    status = "recoverable";
  }

  return {
    session_id: sessionId,
    status,
    lock,
    last_event: lastEvent,
    last_command: lastCommand,
    has_runtime_events: events.length > 0,
    has_session_artifacts: hasSessionArtifacts,
    closeout_present: closeoutPresent,
  };
}
