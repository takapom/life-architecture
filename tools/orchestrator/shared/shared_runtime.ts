import path from "node:path";

export const SESSION_LOCK_FILENAME = "session-lock.json";
export const EVENT_LOG_FILENAME = "event-log.ndjson";

export type SharedRuntimePaths = {
  stateDir: string;
  sessionLockJson: string;
  eventLogNdjson: string;
};

export function resolveSharedRuntimePaths(stateDir: string): SharedRuntimePaths {
  const root = path.resolve(stateDir);
  return {
    stateDir: root,
    sessionLockJson: path.join(root, SESSION_LOCK_FILENAME),
    eventLogNdjson: path.join(root, EVENT_LOG_FILENAME),
  };
}
