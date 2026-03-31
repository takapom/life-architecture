import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import type { StateBackend } from "./runtime_policy";
import { resolveSessionArtifactPaths } from "./session_artifacts";

export const GITHUB_RUN_CONTEXT_SCHEMA_VERSION = 1;

export type GithubRunContext = {
  schema_version: 1;
  generated_at: string;
  repository: string;
  state_backend: "github";
  run_id: string;
  run_issue_number: number;
  run_issue_url: string;
};

type JsonObject = Record<string, unknown>;

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

function parseJsonFile(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
}

export function buildGithubRunContextFromStateArtifact(options: {
  stateDir: string;
  repository?: string;
  generatedAt?: string;
}): GithubRunContext | null {
  const paths = resolveSessionArtifactPaths(options.stateDir);
  if (!existsSync(paths.stateJson)) return null;

  const raw = parseJsonFile(paths.stateJson);
  if (!isObject(raw) || !isObject(raw.github_state)) return null;
  const githubState = raw.github_state;
  const stateBackend = String(githubState.state_backend || "")
    .trim()
    .toLowerCase() as StateBackend;
  if (stateBackend !== "github") return null;

  const repository = String(options.repository || githubState.repository || "").trim();
  const runId = String(githubState.run_id || "").trim();
  if (!repository || !runId) return null;

  const runIssueNumber =
    parseIssueNumberLike(githubState.run_issue_number) ||
    parseIssueNumberLike(githubState.run_issue_url);
  const runIssueUrl = String(githubState.run_issue_url || "").trim();
  return {
    schema_version: GITHUB_RUN_CONTEXT_SCHEMA_VERSION,
    generated_at: options.generatedAt || new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    repository,
    state_backend: "github",
    run_id: runId,
    run_issue_number: runIssueNumber,
    run_issue_url: runIssueUrl,
  };
}

export function writeGithubRunContextFile(options: {
  stateDir: string;
  context: GithubRunContext;
}): string {
  const paths = resolveSessionArtifactPaths(options.stateDir);
  mkdirSync(paths.stateDir, { recursive: true });
  writeFileSync(
    paths.githubRunContextJson,
    `${JSON.stringify(options.context, null, 2)}\n`,
    "utf8"
  );
  return paths.githubRunContextJson;
}

export function readGithubRunContextFile(stateDir: string): GithubRunContext {
  const filePath = resolveSessionArtifactPaths(stateDir).githubRunContextJson;
  if (!existsSync(filePath)) {
    throw new Error(`required file not found: ${filePath}`);
  }

  const raw = parseJsonFile(filePath);
  if (!isObject(raw)) {
    throw new Error("github run context must be a JSON object");
  }

  const schemaVersion = Number(raw.schema_version || 0);
  if (schemaVersion !== GITHUB_RUN_CONTEXT_SCHEMA_VERSION) {
    throw new Error(
      `github run context schema_version must be ${GITHUB_RUN_CONTEXT_SCHEMA_VERSION}`
    );
  }

  const repository = String(raw.repository || "").trim();
  const stateBackend = String(raw.state_backend || "")
    .trim()
    .toLowerCase();
  const runId = String(raw.run_id || "").trim();
  const runIssueNumber = parseIssueNumberLike(raw.run_issue_number);
  const runIssueUrl = String(raw.run_issue_url || "").trim();
  if (!repository) throw new Error("github run context repository is required");
  if (stateBackend !== "github") throw new Error("github run context state_backend must be github");
  if (!runId) throw new Error("github run context run_id is required");

  return {
    schema_version: GITHUB_RUN_CONTEXT_SCHEMA_VERSION,
    generated_at: String(raw.generated_at || "").trim(),
    repository,
    state_backend: "github",
    run_id: runId,
    run_issue_number: runIssueNumber,
    run_issue_url: runIssueUrl,
  };
}
