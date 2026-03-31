import { readFileSync } from "node:fs";
import path from "node:path";
import { deriveTaskScopeResourceClaims } from "../core/task-scope/resource-claims";

type JsonObject = Record<string, unknown>;

export type ExecutionPlanTaskScopeContract = {
  version: number;
  conflict_classes: string[];
  admission_modes: string[];
  verification_classes: string[];
  admission_sources: string[];
  verification_source: string;
  commit_units_required: boolean;
  serialized_scope_key_by_scope_gate_key: Record<string, string>;
  implementation_owner_roots: string[];
  ops_roots: string[];
  repo_root_files: string[];
  hot_root_patterns: string[];
  full_build_sensitive_patterns: string[];
};

export const EXECUTION_PLAN_SOURCE_VERDICTS = [
  "valid",
  "already-fixed",
  "invalid",
  "pending",
] as const;

export type ExecutionPlanSourceVerdict = (typeof EXECUTION_PLAN_SOURCE_VERDICTS)[number];

export type ExecutionPlanTaskScope = {
  owner_bucket: string;
  owner_buckets: string[];
  conflict_class: string;
  admission_mode: "standard" | "landing-exclusive" | "global-exclusive";
  global_invariant: string;
  unfreeze_condition: string;
  verification_class: string;
  scope_gate_keys: string[];
  serialized_scope_keys: string[];
  hot_root_paths: string[];
  resource_claims: Array<{ mode: string; resource: string }>;
};

export type ExecutionPlanSourceItem = {
  id: string;
  verdict: ExecutionPlanSourceVerdict;
  summary: string;
  github_issue: string;
  parent_issue_number?: number;
  parent_issue_url?: string;
};

export type ExecutionPlanNode = {
  id: string;
  issue_node_id: string;
  branch: string;
  priority: number;
  deps: string[];
  github_issue: string;
  scope: string;
  allowed_files: string[];
  commit_units: string[];
  non_goals: string[];
  acceptance_checks: string[];
  tests: string[];
  covers: string[];
  instructions: string;
  task_scope: ExecutionPlanTaskScope;
};

export type ExecutionPlan = {
  base_branch: string;
  max_workers: number;
  merge_mode: "remote-pr";
  merge_queue: boolean;
  cleanup: boolean;
  queue_strategy: "dag_priority";
  require_passing_tests: boolean;
  require_traceability: boolean;
  require_acceptance_checks: boolean;
  issue_tracking: {
    strategy: "remote-github-sot";
    repository: string;
    node_issue_mode: "per-node";
    progress_issue_number: number;
    progress_issue_url: string;
  };
  source_items: ExecutionPlanSourceItem[];
  issue_map: Record<string, string>;
  deferred_items: Array<{ id: string; reason: string }>;
  nodes: ExecutionPlanNode[];
};

const EXECUTION_PLAN_SCHEMA_PATH = path.resolve(import.meta.dir, "./execution-plan.schema.json");
const EXECUTION_PLAN_TASK_SCOPE_CONTRACT_PATH = path.resolve(
  import.meta.dir,
  "./execution-plan-task-scope.contract.json"
);

let executionPlanSchemaCache: JsonObject | null = null;
let executionPlanTaskScopeContractCache: ExecutionPlanTaskScopeContract | null = null;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globToRegex(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const current = pattern[index] || "";
    const next = pattern[index + 1] || "";
    if (current === "*" && next === "*") {
      source += ".*";
      index += 1;
      continue;
    }
    if (current === "*") {
      source += "[^/]*";
      continue;
    }
    if (current === "?") {
      source += "[^/]";
      continue;
    }
    source += escapeRegex(current);
  }
  source += "$";
  return new RegExp(source);
}

function globPrefix(pattern: string): string {
  const normalized = normalizeExecutionPlanPathPattern(pattern);
  const starIndex = normalized.search(/[*?[]/);
  if (starIndex === -1) return normalized;
  return normalized.slice(0, starIndex).replace(/\/+$/, "");
}

export function normalizeExecutionPlanPathPattern(value: string): string {
  return value.replace(/^\.\//, "").replace(/\\/g, "/").trim();
}

export function normalizeExecutionPlanStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

export function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length && left.every((value, index) => value === (right[index] || ""))
  );
}

export function getExecutionPlanSchema(): JsonObject {
  if (executionPlanSchemaCache) return executionPlanSchemaCache;
  executionPlanSchemaCache = JSON.parse(
    readFileSync(EXECUTION_PLAN_SCHEMA_PATH, "utf8")
  ) as JsonObject;
  return executionPlanSchemaCache;
}

export function getExecutionPlanTaskScopeContract(): ExecutionPlanTaskScopeContract {
  if (executionPlanTaskScopeContractCache) return executionPlanTaskScopeContractCache;
  const parsed = JSON.parse(
    readFileSync(EXECUTION_PLAN_TASK_SCOPE_CONTRACT_PATH, "utf8")
  ) as unknown;
  if (!isObject(parsed)) {
    throw new Error("execution-plan task-scope contract must be a JSON object");
  }
  executionPlanTaskScopeContractCache = {
    version: Number(parsed.version || 0),
    conflict_classes: normalizeExecutionPlanStringArray(parsed.conflict_classes),
    admission_modes: normalizeExecutionPlanStringArray(parsed.admission_modes),
    verification_classes: normalizeExecutionPlanStringArray(parsed.verification_classes),
    admission_sources: normalizeExecutionPlanStringArray(parsed.admission_sources),
    verification_source: String(parsed.verification_source || "").trim(),
    commit_units_required: Boolean(parsed.commit_units_required),
    serialized_scope_key_by_scope_gate_key: isObject(parsed.serialized_scope_key_by_scope_gate_key)
      ? Object.fromEntries(
          Object.entries(parsed.serialized_scope_key_by_scope_gate_key).map(([key, value]) => [
            key,
            String(value || "").trim(),
          ])
        )
      : {},
    implementation_owner_roots: normalizeExecutionPlanStringArray(
      parsed.implementation_owner_roots
    ),
    ops_roots: normalizeExecutionPlanStringArray(parsed.ops_roots),
    repo_root_files: normalizeExecutionPlanStringArray(parsed.repo_root_files),
    hot_root_patterns: normalizeExecutionPlanStringArray(parsed.hot_root_patterns),
    full_build_sensitive_patterns: normalizeExecutionPlanStringArray(
      parsed.full_build_sensitive_patterns
    ),
  };
  return executionPlanTaskScopeContractCache;
}

export function isExecutionPlanTaskScopeConflictClass(value: string): boolean {
  return getExecutionPlanTaskScopeContract().conflict_classes.includes(value);
}

export function isExecutionPlanTaskScopeAdmissionMode(value: string): boolean {
  return getExecutionPlanTaskScopeContract().admission_modes.includes(value);
}

export function isExecutionPlanTaskScopeVerificationClass(value: string): boolean {
  return getExecutionPlanTaskScopeContract().verification_classes.includes(value);
}

export function matchesExecutionPlanGlob(value: string, pattern: string): boolean {
  const normalizedValue = normalizeExecutionPlanPathPattern(value);
  const normalizedPattern = normalizeExecutionPlanPathPattern(pattern);
  if (!normalizedValue || !normalizedPattern) return false;
  return globToRegex(normalizedPattern).test(normalizedValue);
}

export function overlapsExecutionPlanPathPattern(left: string, right: string): boolean {
  const a = normalizeExecutionPlanPathPattern(left);
  const b = normalizeExecutionPlanPathPattern(right);

  if (!a || !b) return false;
  if (a === b) return true;

  const aHasGlob = /[*?[]/.test(a);
  const bHasGlob = /[*?[]/.test(b);

  if (!aHasGlob && !bHasGlob) return false;
  if (!aHasGlob) return matchesExecutionPlanGlob(a, b);
  if (!bHasGlob) return matchesExecutionPlanGlob(b, a);

  const aPrefix = globPrefix(a);
  const bPrefix = globPrefix(b);

  if (!aPrefix || !bPrefix) return true;
  if (aPrefix === bPrefix) return true;
  if (aPrefix.startsWith(`${bPrefix}/`) || bPrefix.startsWith(`${aPrefix}/`)) return true;

  return false;
}

export function normalizeExecutionPlanAllowedGlobs(allowedFiles: string[]): string[] {
  return [
    ...new Set(
      allowedFiles.map((pattern) => normalizeExecutionPlanPathPattern(pattern)).filter(Boolean)
    ),
  ];
}

export function extractExecutionPlanTopLevelRoots(patterns: string[]): string[] {
  const roots = new Set<string>();

  for (const pattern of patterns) {
    const normalized = normalizeExecutionPlanPathPattern(pattern);
    if (!normalized) continue;

    const trimmed = normalized.replace(/^\/+/, "");
    const [rawRoot = ""] = trimmed.split("/", 1);
    const root = rawRoot.trim() || "(root)";
    roots.add(root);
  }

  return [...roots].sort((left, right) => left.localeCompare(right));
}

export function extractExecutionPlanOwnerBuckets(patterns: string[]): string[] {
  const contract = getExecutionPlanTaskScopeContract();
  const implementationRoots = new Set(contract.implementation_owner_roots);
  const buckets = new Set<string>();

  for (const pattern of patterns) {
    const normalized = normalizeExecutionPlanPathPattern(pattern);
    if (!normalized) continue;

    const parts = normalized.replace(/^\/+/, "").split("/").filter(Boolean);
    const [root = "", owner = ""] = parts;
    if (!root) continue;

    if (implementationRoots.has(root) && owner) {
      buckets.add(`${root}/${owner}`);
      continue;
    }

    buckets.add(root);
  }

  return [...buckets].sort((left, right) => left.localeCompare(right));
}

export function extractExecutionPlanHotRootPaths(patterns: string[]): string[] {
  const contract = getExecutionPlanTaskScopeContract();
  const normalizedPatterns = normalizeExecutionPlanAllowedGlobs(patterns);
  return normalizedPatterns
    .filter((pattern) =>
      contract.hot_root_patterns.some((hotRootPattern) =>
        overlapsExecutionPlanPathPattern(pattern, hotRootPattern)
      )
    )
    .sort((left, right) => left.localeCompare(right));
}

export function resolveExecutionPlanTaskScopeConflictClass(
  touchesHotRoot: boolean,
  ownerBucketCount: number
): string {
  if (touchesHotRoot) return "integration-hot";
  if (ownerBucketCount <= 1) return "parallel-safe";
  return "serial";
}

export function resolveExecutionPlanTaskScopeVerificationClass(
  allowedGlobs: string[],
  topLevelRoots: string[],
  touchesHotRoot: boolean
): string {
  const contract = getExecutionPlanTaskScopeContract();
  const implementationRoots = new Set(contract.implementation_owner_roots);

  if (
    touchesHotRoot ||
    allowedGlobs.some((pattern) =>
      contract.full_build_sensitive_patterns.some((sensitivePattern) =>
        overlapsExecutionPlanPathPattern(pattern, sensitivePattern)
      )
    )
  ) {
    return "full-build-sensitive";
  }
  if (topLevelRoots.some((root) => implementationRoots.has(root))) {
    return "affected-typecheck";
  }
  return "cheap";
}

export function resolveExecutionPlanTaskScopeGateKeys(options: {
  allowedFiles: string[];
  availableKeys?: string[];
}): string[] {
  const available = options.availableKeys ? new Set(options.availableKeys) : null;
  const resolved: string[] = [];
  for (const allowedFile of options.allowedFiles) {
    const candidates = resolveExecutionPlanScopeGateKeyCandidates(
      normalizeExecutionPlanPathPattern(allowedFile)
    );
    const selected =
      candidates.find((candidate) => !available || available.has(candidate)) || candidates[0] || "";
    if (selected && !resolved.includes(selected)) {
      resolved.push(selected);
    }
  }
  return resolved;
}

export function resolveExecutionPlanSerializedScopeKeys(scopeGateKeys: string[]): string[] {
  const contract = getExecutionPlanTaskScopeContract();
  const resolved: string[] = [];
  for (const scopeGateKey of scopeGateKeys) {
    const serialized =
      contract.serialized_scope_key_by_scope_gate_key[scopeGateKey]?.trim() ||
      (scopeGateKey.startsWith("packages/") ||
      scopeGateKey.startsWith("domains/") ||
      scopeGateKey.startsWith("processes/")
        ? scopeGateKey.replaceAll("/", "_")
        : scopeGateKey);
    if (serialized && !resolved.includes(serialized)) {
      resolved.push(serialized);
    }
  }
  return resolved;
}

function resolveExecutionPlanScopeGateKeyCandidates(pathPattern: string): string[] {
  const contract = getExecutionPlanTaskScopeContract();
  const normalized = normalizeExecutionPlanPathPattern(pathPattern).replace(/[*?[].*$/, "");
  if (!normalized) return [];

  const parts = normalized.split("/").filter(Boolean);
  const [root = "", owner = "", child = ""] = parts;
  if (!root) return [];

  if (root === "apps") {
    let candidates = [owner, "apps", "repo"];
    if (owner === "api") {
      candidates = ["api", "apps", "repo"];
    } else if (owner === "app") {
      candidates = ["app", "apps", "repo"];
    } else if (owner === "platform-admin") {
      candidates = ["platform-admin", "apps", "repo"];
    } else if (owner === "public-docs") {
      candidates = ["public-docs", "apps", "repo"];
    } else if (owner === "worker") {
      candidates = ["worker", "apps", "repo"];
    } else if (owner === "agent-runner") {
      candidates = ["agent-runner", "worker", "apps", "repo"];
    } else if (owner === "agent-session-runtime") {
      candidates = ["agent-session-runtime", "worker", "apps", "repo"];
    }
    return candidates.filter(Boolean);
  }

  if (contract.implementation_owner_roots.includes(root) && root !== "apps") {
    return owner ? [`${root}/${owner}`, root, "repo"] : [root, "repo"];
  }

  if (root === "docs" && owner === "contracts" && child === "governance") {
    return ["governance-docs", "ops", "repo"];
  }

  if (root === "platform" && owner === "dev" && (child === "local" || child === "worktree")) {
    return ["worktree-runtime", "ops", "repo"];
  }

  if (contract.ops_roots.includes(root)) {
    return ["ops", "repo"];
  }

  if (contract.repo_root_files.includes(root)) {
    return ["repo"];
  }

  return ["repo"];
}

export function buildExecutionPlanTaskScope(
  allowedFiles: string[],
  _commitUnits: string[] = [],
  options: {
    admissionMode?: string;
    globalInvariant?: string;
    unfreezeCondition?: string;
  } = {}
): ExecutionPlanTaskScope {
  const allowedGlobs = normalizeExecutionPlanAllowedGlobs(allowedFiles);
  const topLevelRoots = extractExecutionPlanTopLevelRoots(allowedGlobs);
  const ownerBuckets = extractExecutionPlanOwnerBuckets(allowedGlobs);
  const hotRootPaths = extractExecutionPlanHotRootPaths(allowedGlobs);
  const touchesHotRoot = hotRootPaths.length > 0;
  const scopeGateKeys = resolveExecutionPlanTaskScopeGateKeys({
    allowedFiles: allowedGlobs,
  });
  const serializedScopeKeys = resolveExecutionPlanSerializedScopeKeys(scopeGateKeys);
  const normalizedAdmissionMode = String(options.admissionMode || "")
    .trim()
    .toLowerCase();
  let admissionMode: "standard" | "landing-exclusive" | "global-exclusive" = "standard";
  if (normalizedAdmissionMode === "global-exclusive") {
    admissionMode = "global-exclusive";
  } else if (normalizedAdmissionMode === "landing-exclusive") {
    admissionMode = "landing-exclusive";
  }
  const globalInvariant =
    admissionMode === "global-exclusive" ? String(options.globalInvariant || "").trim() : "";
  const unfreezeCondition =
    admissionMode === "global-exclusive" ? String(options.unfreezeCondition || "").trim() : "";

  return {
    owner_bucket: ownerBuckets[0] || "(root)",
    owner_buckets: ownerBuckets,
    conflict_class: resolveExecutionPlanTaskScopeConflictClass(touchesHotRoot, ownerBuckets.length),
    admission_mode: admissionMode,
    global_invariant: globalInvariant,
    unfreeze_condition: unfreezeCondition,
    verification_class: resolveExecutionPlanTaskScopeVerificationClass(
      allowedGlobs,
      topLevelRoots,
      touchesHotRoot
    ),
    scope_gate_keys: scopeGateKeys,
    serialized_scope_keys: serializedScopeKeys,
    hot_root_paths: hotRootPaths,
    resource_claims: deriveTaskScopeResourceClaims(allowedGlobs),
  };
}
