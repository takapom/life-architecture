import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Ajv from "ajv";
import {
  buildExecutionPlanTaskScope as buildExecutionPlanTaskScopeFromContract,
  getExecutionPlanSchema,
} from "../../contracts/execution-plan";
import { ensureOrchestratorBinary } from "./rust-runtime";

export type {
  ExecutionPlan,
  ExecutionPlanNode,
  ExecutionPlanSourceItem,
  ExecutionPlanTaskScope,
} from "../../contracts/execution-plan";

type JsonObject = Record<string, unknown>;
const executionPlanSchema = getExecutionPlanSchema() as JsonObject;
const executionPlanSchemaValidator = new Ajv({
  allErrors: true,
  strict: false,
}).compile(executionPlanSchema);
const repoRoot = path.resolve(import.meta.dir, "../../..");
const VALIDATION_SESSION_ID = "sess-20260330120000-planval1";

function formatSchemaErrorPath(instancePath: string, missingProperty?: string): string {
  const base = instancePath || "/";
  if (!missingProperty) return base;
  return `${base.replace(/\/$/, "")}/${missingProperty}`;
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function validateExecutionPlanSchema(payload: unknown): string[] {
  const isValid = executionPlanSchemaValidator(payload);
  if (isValid) return [];
  return (executionPlanSchemaValidator.errors || []).map((error) => {
    const missingProperty =
      error.keyword === "required" && typeof error.params.missingProperty === "string"
        ? error.params.missingProperty
        : undefined;
    const schemaPath = formatSchemaErrorPath(error.instancePath || "/", missingProperty);
    return `schema ${schemaPath}: ${error.message || "invalid payload"}`;
  });
}

export function buildExecutionPlanTaskScope(
  allowedFiles: string[],
  commitUnits: string[] = [],
  options: {
    admissionMode?: string;
    globalInvariant?: string;
    unfreezeCondition?: string;
  } = {}
) {
  return buildExecutionPlanTaskScopeFromContract(allowedFiles, commitUnits, options);
}

export function validateExecutionPlan(payload: unknown): string[] {
  const canonicalPayload = canonicalizeExecutionPlanPayload(payload);
  const schemaErrors = translateSchemaErrorsForDelegatedValidation(
    validateExecutionPlanSchema(canonicalPayload),
    canonicalPayload,
    payload
  );
  if (schemaErrors.length > 0) {
    return schemaErrors;
  }

  const tempDir = mkdtempSync(path.join(os.tmpdir(), "execution-plan-validation-"));
  const stateDir = path.join(tempDir, "state");
  const executionPlanPath = path.join(stateDir, "inputs", "execution-plan.json");
  mkdirSync(path.dirname(executionPlanPath), { recursive: true });
  writeFileSync(executionPlanPath, `${JSON.stringify(canonicalPayload, null, 2)}\n`, "utf8");

  try {
    const binaryPath = ensureOrchestratorBinary({ repoRoot });
    const result = spawnSync(
      binaryPath,
      [
        "state-bootstrap",
        "--repo-root",
        repoRoot,
        "--state-dir",
        stateDir,
        "--session-id",
        VALIDATION_SESSION_ID,
        "--state-backend",
        "local",
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    if ((result.status ?? 1) === 0) {
      return [];
    }

    const detail = `${result.stderr || ""}\n${result.stdout || ""}`.trim();
    return extractDelegatedValidationErrors(detail);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function extractDelegatedValidationErrors(detail: string): string[] {
  const lines = detail
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const markerIndex = lines.findIndex(
    (line) =>
      line.startsWith("execution plan semantic validation failed:") ||
      line.startsWith("execution plan schema validation failed:")
  );
  if (markerIndex >= 0) {
    const errors = lines
      .slice(markerIndex + 1)
      .map((line) => line.replace(/^- /, "").trim())
      .filter(Boolean);
    if (errors.length > 0) {
      return errors;
    }
  }
  return [detail || "delegated execution-plan validation failed"];
}

function canonicalizeExecutionPlanPayload(payload: unknown): unknown {
  if (!isObject(payload)) {
    return payload;
  }

  const canonical = structuredClone(payload) as JsonObject;
  canonical.base_branch = String(canonical.base_branch || "main").trim() || "main";
  canonical.max_workers =
    Number.isInteger(canonical.max_workers) && Number(canonical.max_workers) > 0
      ? Number(canonical.max_workers)
      : 4;
  canonical.merge_mode = String(canonical.merge_mode || "remote-pr").trim() || "remote-pr";
  canonical.merge_queue = Boolean(canonical.merge_queue);
  canonical.cleanup = canonical.cleanup === undefined ? true : Boolean(canonical.cleanup);
  canonical.queue_strategy =
    String(canonical.queue_strategy || "dag_priority").trim() || "dag_priority";
  canonical.require_passing_tests =
    canonical.require_passing_tests === undefined ? true : Boolean(canonical.require_passing_tests);
  canonical.require_traceability =
    canonical.require_traceability === undefined ? true : Boolean(canonical.require_traceability);
  canonical.require_acceptance_checks =
    canonical.require_acceptance_checks === undefined
      ? true
      : Boolean(canonical.require_acceptance_checks);
  const issueMap = isObject(canonical.issue_map) ? canonical.issue_map : {};

  if (Array.isArray(canonical.source_items)) {
    canonical.source_items = canonical.source_items.map((item) => {
      if (!isObject(item)) {
        return item;
      }
      const canonicalItem = structuredClone(item) as JsonObject;
      const sourceId = String(canonicalItem.id || "").trim();
      canonicalItem.github_issue =
        String(canonicalItem.github_issue || "").trim() ||
        (sourceId ? String(issueMap[sourceId] || "").trim() : "");
      const hasParentIssueNumber = Object.hasOwn(canonicalItem, "parent_issue_number");
      const hasParentIssueUrl = Object.hasOwn(canonicalItem, "parent_issue_url");
      if (hasParentIssueNumber || hasParentIssueUrl) {
        canonicalItem.parent_issue_number =
          Number.isInteger(canonicalItem.parent_issue_number) &&
          Number(canonicalItem.parent_issue_number) > 0
            ? Number(canonicalItem.parent_issue_number)
            : 0;
        canonicalItem.parent_issue_url = String(canonicalItem.parent_issue_url || "").trim();
      }
      return canonicalItem;
    });
  }

  if (Array.isArray(canonical.nodes)) {
    canonical.nodes = canonical.nodes.map((node, index) => {
      if (!isObject(node)) {
        return node;
      }
      const canonicalNode = structuredClone(node) as JsonObject;
      const nodeId = String(canonicalNode.id || "").trim() || `NODE_${index + 1}`;
      canonicalNode.issue_node_id =
        String(canonicalNode.issue_node_id || "").trim() || `NODE_${nodeId}`;
      canonicalNode.priority =
        Number.isInteger(canonicalNode.priority) && Number(canonicalNode.priority) >= 0
          ? Number(canonicalNode.priority)
          : 0;
      canonicalNode.deps = Array.isArray(canonicalNode.deps) ? canonicalNode.deps : [];
      canonicalNode.scope =
        String(canonicalNode.scope || "").trim() ||
        (Array.isArray(canonicalNode.allowed_files)
          ? canonicalNode.allowed_files.map((entry) => String(entry || "").trim()).join("\n")
          : "");
      canonicalNode.github_issue = String(canonicalNode.github_issue || "").trim();
      canonicalNode.non_goals = Array.isArray(canonicalNode.non_goals)
        ? canonicalNode.non_goals
        : [];
      canonicalNode.instructions =
        String(canonicalNode.instructions || "").trim() ||
        "Run only the commands explicitly listed for this execution-plan node.";
      return canonicalNode;
    });
  }

  return canonical;
}

function translateSchemaErrorsForDelegatedValidation(
  errors: string[],
  payload: unknown,
  originalPayload: unknown
): string[] {
  if (!isObject(payload)) {
    return errors;
  }
  const nodes = Array.isArray(payload.nodes) ? payload.nodes : [];
  const sourceItems =
    !Array.isArray(originalPayload) &&
    isObject(originalPayload) &&
    Array.isArray(originalPayload.source_items)
      ? originalPayload.source_items
      : [];
  const translated: string[] = [];
  for (const entry of errors) {
    if (entry === "schema /nodes: must NOT have fewer than 1 items") {
      translated.push("nodes must be a non-empty array");
      continue;
    }
    const parentIssueMatch = entry.match(
      /^schema \/source_items\/(\d+)\/parent_issue_(number|url): /
    );
    if (parentIssueMatch) {
      const index = Number(parentIssueMatch[1] || -1);
      const sourceItem =
        index >= 0 && index < sourceItems.length && isObject(sourceItems[index])
          ? sourceItems[index]
          : null;
      if (sourceItem) {
        const hasParentIssueNumber = Object.hasOwn(sourceItem, "parent_issue_number");
        const hasParentIssueUrl = Object.hasOwn(sourceItem, "parent_issue_url");
        const parentIssueUrl = String(sourceItem.parent_issue_url || "").trim();
        if (hasParentIssueUrl && !parentIssueUrl) {
          translated.push(`source_items[${index}].parent_issue_url is required`);
          continue;
        }
        if (hasParentIssueNumber || hasParentIssueUrl) {
          translated.push(
            `source_items[${index}] must set parent_issue_number and parent_issue_url together`
          );
          continue;
        }
      }
    }
    const taskScopeMatch = entry.match(/^schema \/nodes\/(\d+)\/task_scope: /);
    if (taskScopeMatch) {
      const index = Number(taskScopeMatch[1] || -1);
      const node =
        index >= 0 && index < nodes.length && isObject(nodes[index]) ? nodes[index] : null;
      const nodeId = node ? String(node.id || "").trim() : "";
      translated.push(`node ${nodeId || "<unknown>"}: task_scope is required`);
      continue;
    }
    const githubIssueMatch = entry.match(/^schema \/nodes\/(\d+)\/github_issue: /);
    if (githubIssueMatch) {
      const index = Number(githubIssueMatch[1] || -1);
      const node =
        index >= 0 && index < nodes.length && isObject(nodes[index]) ? nodes[index] : null;
      const nodeId = node ? String(node.id || "").trim() : "";
      translated.push(`node ${nodeId || "<unknown>"}: github_issue is required`);
      continue;
    }
    const coversMinMatch = entry.match(
      /^schema \/nodes\/(\d+)\/covers: must NOT have fewer than 1 items$/
    );
    if (coversMinMatch) {
      const validSourceId =
        Array.isArray(payload.source_items) &&
        payload.source_items.find(
          (item) =>
            isObject(item) &&
            String(item.verdict || "")
              .trim()
              .toLowerCase() === "valid"
        ) &&
        String(
          (
            payload.source_items.find(
              (item) =>
                isObject(item) &&
                String(item.verdict || "")
                  .trim()
                  .toLowerCase() === "valid"
            ) as JsonObject
          ).id || ""
        ).trim();
      if (validSourceId) {
        translated.push(`valid source item ${validSourceId} must be covered by exactly one node`);
        continue;
      }
    }
    const coversMaxMatch = entry.match(
      /^schema \/nodes\/(\d+)\/covers: must NOT have more than 1 items$/
    );
    if (coversMaxMatch) {
      const index = Number(coversMaxMatch[1] || -1);
      const node =
        index >= 0 && index < nodes.length && isObject(nodes[index]) ? nodes[index] : null;
      const nodeId = node ? String(node.id || "").trim() : "";
      translated.push(`node ${nodeId || "<unknown>"}: covers must contain exactly one source id`);
      if (Array.isArray(payload.source_items)) {
        for (const sourceItem of payload.source_items) {
          if (!isObject(sourceItem)) continue;
          if (
            String(sourceItem.verdict || "")
              .trim()
              .toLowerCase() === "valid"
          )
            continue;
          const sourceId = String(sourceItem.id || "").trim();
          if (sourceId) {
            translated.push(`non-valid source item ${sourceId} must not be covered by nodes`);
          }
        }
      }
      continue;
    }
    translated.push(entry);
  }
  return [...new Set(translated)];
}
