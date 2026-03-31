import { existsSync, readFileSync } from "node:fs";

import {
  resolveSessionArtifactPaths,
  SESSION_ARTIFACT_PRESENCE_DIRECTORY_KEYS,
  SESSION_ARTIFACT_PRESENCE_FILE_KEYS,
  type SessionArtifactPaths,
} from "./session_artifacts";

type JsonObject = Record<string, unknown>;

export type SessionStateArtifact = {
  source_path: string;
  raw: JsonObject;
  nodes: Record<string, JsonObject>;
};

export type SessionExecutionPlanArtifact = {
  source_path: string;
  raw: JsonObject;
  repository: string;
};

export type SessionGithubRunContextArtifact = {
  repository: string;
  run_id: string;
  run_issue_number: number;
  run_issue_url: string;
};

export type SessionNodeState = {
  status: string;
  branch: string;
  worktree: string;
  attempts: number;
  last_update: string;
};

export type SessionStatePayload = {
  updated_at: string;
  nodes: Record<string, SessionNodeState>;
};

export type SessionGateNode = {
  node_id: string;
  status: string;
  branch: string;
  summary: string;
  failure_reason: string;
  pr_url: string;
  artifacts: Record<string, string>;
};

export type SessionGateResultsPayload = {
  generated_at: string;
  state_updated_at: string;
  nodes: SessionGateNode[];
};

export type SessionArtifactSnapshot = {
  state_dir: string;
  paths: SessionArtifactPaths;
  has_session_artifacts: boolean;
  execution_plan: SessionExecutionPlanArtifact | null;
  state: SessionStateArtifact | null;
  gate_results: unknown | null;
  followup_drafts: unknown | null;
  closeout_summary: unknown | null;
};

export type SessionDecisionArtifactSnapshot = SessionArtifactSnapshot & {
  state: SessionStateArtifact;
  gate_results: unknown;
};

export type SessionDecisionPayloadSnapshot = SessionArtifactSnapshot & {
  state: SessionStateArtifact;
  gate_results: SessionGateResultsPayload;
  state_payload: SessionStatePayload;
};

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseIssueNumberLike(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  const text = String(value || "").trim();
  if (!text) return 0;
  const numberMatch = text.match(/^#?(\d+)$/);
  if (numberMatch) return Number(numberMatch[1] || "0");
  const urlMatch = text.match(/\/issues\/(\d+)(?:\/)?$/);
  if (urlMatch) return Number(urlMatch[1] || "0");
  return 0;
}

function readJsonArtifact(filePath: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`invalid session artifact JSON: ${filePath} (${(error as Error).message})`);
  }
}

function readOptionalJsonArtifact(filePath: string): unknown | null {
  if (!existsSync(filePath)) return null;
  return readJsonArtifact(filePath);
}

export function detectSessionArtifacts(stateDir: string): boolean {
  const paths = resolveSessionArtifactPaths(stateDir);
  return (
    SESSION_ARTIFACT_PRESENCE_FILE_KEYS.some((key) => existsSync(paths[key])) ||
    SESSION_ARTIFACT_PRESENCE_DIRECTORY_KEYS.some((key) => existsSync(paths[key]))
  );
}

export function parseSessionStateArtifact(raw: unknown, sourcePath: string): SessionStateArtifact {
  if (!isObject(raw) || !isObject(raw.nodes)) {
    throw new Error(`invalid session state payload: ${sourcePath}`);
  }

  const nodes = Object.entries(raw.nodes).reduce<Record<string, JsonObject>>(
    (acc, [nodeId, rawNode]) => {
      if (!isObject(rawNode)) {
        throw new Error(`invalid session state node payload: ${sourcePath} (${nodeId})`);
      }
      acc[nodeId] = rawNode;
      return acc;
    },
    {}
  );

  return {
    source_path: sourcePath,
    raw,
    nodes,
  };
}

export function parseSessionExecutionPlanArtifact(
  raw: unknown,
  sourcePath: string
): SessionExecutionPlanArtifact {
  if (!isObject(raw)) {
    throw new Error(`invalid execution plan payload: ${sourcePath}`);
  }

  const issueTracking = isObject(raw.issue_tracking) ? raw.issue_tracking : {};
  return {
    source_path: sourcePath,
    raw,
    repository: String(issueTracking.repository || "").trim(),
  };
}

export function parseSessionStatePayload(raw: unknown): SessionStatePayload {
  if (!isObject(raw)) {
    throw new Error("state.json must be a JSON object");
  }

  const rawNodes = raw.nodes;
  if (!isObject(rawNodes)) {
    throw new Error("state.json must include nodes object");
  }

  const nodes = Object.entries(rawNodes).reduce<Record<string, SessionNodeState>>(
    (acc, [nodeId, rawNode]) => {
      const trimmedNodeId = nodeId.trim();
      if (!trimmedNodeId) return acc;
      if (!isObject(rawNode)) {
        throw new Error(`state.nodes.${trimmedNodeId} must be an object`);
      }
      acc[trimmedNodeId] = {
        status: String(rawNode.status || "").trim(),
        branch: String(rawNode.branch || "").trim(),
        worktree: String(rawNode.worktree || "").trim(),
        attempts: Number(rawNode.attempts || 0),
        last_update: String(rawNode.last_update || "").trim(),
      };
      return acc;
    },
    {}
  );

  if (Object.keys(nodes).length === 0) {
    throw new Error("state.json nodes must not be empty");
  }

  return {
    updated_at: String(raw.updated_at || "").trim(),
    nodes,
  };
}

export function parseSessionGateResultsPayload(raw: unknown): SessionGateResultsPayload {
  if (!isObject(raw)) {
    throw new Error("gate-results.json must be a JSON object");
  }

  const rawNodes = Array.isArray(raw.nodes) ? raw.nodes : [];
  const nodes = rawNodes.map((entry, index) => {
    if (!isObject(entry)) {
      throw new Error(`gate-results.nodes[${index}] must be an object`);
    }

    const artifactsRaw = isObject(entry.artifacts)
      ? (entry.artifacts as Record<string, unknown>)
      : {};

    return {
      node_id: String(entry.node_id || "").trim(),
      status: String(entry.status || "").trim(),
      branch: String(entry.branch || "").trim(),
      summary: String(entry.summary || "").trim(),
      failure_reason: String(entry.failure_reason || "").trim(),
      pr_url: String(entry.pr_url || "").trim(),
      artifacts: {
        status_json: String(artifactsRaw.status_json || "").trim(),
        conflict_json: String(artifactsRaw.conflict_json || "").trim(),
        review_json: String(artifactsRaw.review_json || "").trim(),
      },
    };
  });

  return {
    generated_at: String(raw.generated_at || "").trim(),
    state_updated_at: String(raw.state_updated_at || "").trim(),
    nodes,
  };
}

export function readSessionExecutionPlanArtifact(
  stateDir: string
): SessionExecutionPlanArtifact | null {
  const paths = resolveSessionArtifactPaths(stateDir);
  if (!existsSync(paths.executionPlanJson)) return null;
  return parseSessionExecutionPlanArtifact(
    readJsonArtifact(paths.executionPlanJson),
    paths.executionPlanJson
  );
}

export function readSessionStateArtifact(stateDir: string): SessionStateArtifact | null {
  const paths = resolveSessionArtifactPaths(stateDir);
  if (!existsSync(paths.stateJson)) return null;
  return parseSessionStateArtifact(readJsonArtifact(paths.stateJson), paths.stateJson);
}

export function readSessionGithubRunContextArtifact(options: {
  stateDir: string;
  repository?: string;
}): SessionGithubRunContextArtifact | null {
  const state = readSessionStateArtifact(options.stateDir);
  if (!state) return null;

  const githubState = isObject(state.raw.github_state) ? state.raw.github_state : null;
  if (!githubState) return null;

  const stateBackend = String(githubState.state_backend || "")
    .trim()
    .toLowerCase();
  if (stateBackend !== "github") return null;

  const repository = String(options.repository || githubState.repository || "").trim();
  const runId = String(githubState.run_id || "").trim();
  if (!repository || !runId) return null;

  return {
    repository,
    run_id: runId,
    run_issue_number:
      parseIssueNumberLike(githubState.run_issue_number) ||
      parseIssueNumberLike(githubState.run_issue_url),
    run_issue_url: String(githubState.run_issue_url || "").trim(),
  };
}

export function readSessionArtifactSnapshot(stateDir: string): SessionArtifactSnapshot {
  const paths = resolveSessionArtifactPaths(stateDir);
  const stateRaw = readOptionalJsonArtifact(paths.stateJson);

  return {
    state_dir: paths.stateDir,
    paths,
    has_session_artifacts: detectSessionArtifacts(paths.stateDir),
    execution_plan: existsSync(paths.executionPlanJson)
      ? parseSessionExecutionPlanArtifact(
          readJsonArtifact(paths.executionPlanJson),
          paths.executionPlanJson
        )
      : null,
    state: stateRaw === null ? null : parseSessionStateArtifact(stateRaw, paths.stateJson),
    gate_results: readOptionalJsonArtifact(paths.gateResultsJson),
    followup_drafts: readOptionalJsonArtifact(paths.followupDraftsJson),
    closeout_summary: readOptionalJsonArtifact(paths.closeoutSummaryJson),
  };
}

export function readSessionDecisionArtifactSnapshot(
  stateDir: string
): SessionDecisionArtifactSnapshot {
  const snapshot = readSessionArtifactSnapshot(stateDir);
  if (!snapshot.state) {
    throw new Error(`required artifact missing: ${snapshot.paths.stateJson}`);
  }
  if (snapshot.gate_results === null) {
    throw new Error(`required artifact missing: ${snapshot.paths.gateResultsJson}`);
  }
  return {
    ...snapshot,
    state: snapshot.state,
    gate_results: snapshot.gate_results,
  };
}

export function readSessionDecisionPayloadSnapshot(
  stateDir: string
): SessionDecisionPayloadSnapshot {
  const snapshot = readSessionDecisionArtifactSnapshot(stateDir);
  return {
    ...snapshot,
    gate_results: parseSessionGateResultsPayload(snapshot.gate_results),
    state_payload: parseSessionStatePayload(snapshot.state.raw),
  };
}
