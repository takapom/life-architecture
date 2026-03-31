import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { resolveCanonicalTaskRootFromRepoRoot } from "./worktree";

export const TOOL_OPERATIONAL_EVIDENCE_SCHEMA_VERSION = 1 as const;

export type ToolOperationalEvidenceToolId = "orchestrator" | "repoctl";
export type ToolOperationalEvidenceOutcome = "success" | "failure";

export type ToolOperationalEvidenceRecord = {
  schema_version: 1;
  tool_id: ToolOperationalEvidenceToolId;
  command: string;
  args: string[];
  outcome: ToolOperationalEvidenceOutcome;
  recorded_at: string;
  repo_root: string;
  cwd: string;
  duration_ms: number;
  detail?: string;
  delegated_script?: string;
  binary_path?: string;
};

type AppendToolOperationalEvidenceOptions = {
  toolId: ToolOperationalEvidenceToolId;
  command: string;
  args?: readonly string[];
  outcome: ToolOperationalEvidenceOutcome;
  repoRoot: string;
  cwd?: string;
  durationMs: number;
  detail?: string;
  delegatedScript?: string;
  binaryPath?: string;
  evidenceRoot?: string;
  recordedAt?: string;
};

type JsonObject = Record<string, unknown>;

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function requireText(value: unknown, label: string): string {
  const text = String(value || "").trim();
  if (!text) {
    throw new Error(`tool operational evidence ${label} is required`);
  }
  return text;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  throw new Error(`tool operational evidence ${label} must be a non-negative integer`);
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveToolOperationalEvidenceRoot(repoRoot: string, evidenceRoot?: string): string {
  if (String(evidenceRoot || "").trim()) {
    return path.resolve(evidenceRoot as string);
  }
  return path.join(
    resolveCanonicalTaskRootFromRepoRoot(repoRoot),
    ".omta",
    "tool-operational-evidence"
  );
}

export function resolveToolOperationalEvidencePath(options: {
  repoRoot: string;
  toolId: ToolOperationalEvidenceToolId;
  evidenceRoot?: string;
}): string {
  return path.join(
    resolveToolOperationalEvidenceRoot(options.repoRoot, options.evidenceRoot),
    `${options.toolId}.ndjson`
  );
}

function parseToolOperationalEvidenceRecord(raw: unknown): ToolOperationalEvidenceRecord {
  if (!isObject(raw)) {
    throw new Error("tool operational evidence entry must be a JSON object");
  }
  const schemaVersion = Number(raw.schema_version || 0);
  if (schemaVersion !== TOOL_OPERATIONAL_EVIDENCE_SCHEMA_VERSION) {
    throw new Error(
      `tool operational evidence schema_version must be ${TOOL_OPERATIONAL_EVIDENCE_SCHEMA_VERSION}`
    );
  }
  const toolId = requireText(raw.tool_id, "tool_id");
  if (toolId !== "orchestrator" && toolId !== "repoctl") {
    throw new Error(`tool operational evidence tool_id is invalid: ${toolId}`);
  }
  const outcome = requireText(raw.outcome, "outcome");
  if (outcome !== "success" && outcome !== "failure") {
    throw new Error(`tool operational evidence outcome is invalid: ${outcome}`);
  }
  const args = raw.args;
  if (!Array.isArray(args) || args.some((entry) => typeof entry !== "string")) {
    throw new Error("tool operational evidence args must be a string array");
  }

  const record: ToolOperationalEvidenceRecord = {
    schema_version: TOOL_OPERATIONAL_EVIDENCE_SCHEMA_VERSION,
    tool_id: toolId,
    command: requireText(raw.command, "command"),
    args,
    outcome,
    recorded_at: requireText(raw.recorded_at, "recorded_at"),
    repo_root: requireText(raw.repo_root, "repo_root"),
    cwd: requireText(raw.cwd, "cwd"),
    duration_ms: requireNonNegativeInteger(raw.duration_ms, "duration_ms"),
  };
  const detail = String(raw.detail || "").trim();
  if (detail) {
    record.detail = detail;
  }
  const delegatedScript = String(raw.delegated_script || "").trim();
  if (delegatedScript) {
    record.delegated_script = delegatedScript;
  }
  const binaryPath = String(raw.binary_path || "").trim();
  if (binaryPath) {
    record.binary_path = binaryPath;
  }
  return record;
}

export function readToolOperationalEvidence(options: {
  repoRoot: string;
  toolId: ToolOperationalEvidenceToolId;
  evidenceRoot?: string;
}): ToolOperationalEvidenceRecord[] {
  const evidencePath = resolveToolOperationalEvidencePath(options);
  if (!existsSync(evidencePath)) {
    return [];
  }
  return readFileSync(evidencePath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return parseToolOperationalEvidenceRecord(JSON.parse(line) as unknown);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `tool operational evidence line ${index + 1} is invalid at ${evidencePath}: ${detail}`
        );
      }
    });
}

export function appendToolOperationalEvidence(
  options: AppendToolOperationalEvidenceOptions
): ToolOperationalEvidenceRecord {
  const record: ToolOperationalEvidenceRecord = {
    schema_version: TOOL_OPERATIONAL_EVIDENCE_SCHEMA_VERSION,
    tool_id: options.toolId,
    command: requireText(options.command, "command"),
    args: [...(options.args || [])].map((entry) => String(entry)),
    outcome: options.outcome,
    recorded_at: String(options.recordedAt || "").trim() || nowIso(),
    repo_root: path.resolve(options.repoRoot),
    cwd: path.resolve(options.cwd || options.repoRoot),
    duration_ms: requireNonNegativeInteger(
      Math.max(0, Math.trunc(options.durationMs)),
      "duration_ms"
    ),
  };
  const detail = String(options.detail || "").trim();
  if (detail) {
    record.detail = detail;
  }
  const delegatedScript = String(options.delegatedScript || "").trim();
  if (delegatedScript) {
    record.delegated_script = delegatedScript;
  }
  const binaryPath = String(options.binaryPath || "").trim();
  if (binaryPath) {
    record.binary_path = path.resolve(binaryPath);
  }

  const evidencePath = resolveToolOperationalEvidencePath(options);
  mkdirSync(path.dirname(evidencePath), { recursive: true });
  appendFileSync(evidencePath, `${JSON.stringify(record)}\n`, "utf8");
  return record;
}
