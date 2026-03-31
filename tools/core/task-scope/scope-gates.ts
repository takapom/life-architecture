import { normalizePathPattern } from "../issue-graph-types";

function trimGlobSuffix(value: string): string {
  const wildcardIndex = value.search(/[[][*?]/);
  if (wildcardIndex < 0) return value.replace(/\/+$/, "");
  return value.slice(0, wildcardIndex).replace(/\/+$/, "");
}

function normalizeScopePath(value: string): string {
  return trimGlobSuffix(normalizePathPattern(value));
}

function pickOwnerScopedKey(root: string, owner: string): string[] {
  if (!owner) return [root, "repo"];
  return [`${root}/${owner}`, root, "repo"];
}

function selectScopeGateKey(candidates: string[], availableKeySet: Set<string>): string | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0] || null;

  const nonRepoAvailable = candidates.find(
    (candidate) => candidate !== "repo" && availableKeySet.has(candidate)
  );
  if (nonRepoAvailable) return nonRepoAvailable;

  return candidates[0] || null;
}

function scriptScopeGateCandidates(owner: string): string[] {
  if (owner.startsWith("check-") || owner.startsWith("fix-")) {
    return ["repo-policy", "scripts", "ops", "repo"];
  }
  if (owner.startsWith("report-")) {
    return ["generated-tooling", "scripts", "ops", "repo"];
  }
  return ["scripts", "ops", "repo"];
}

function docsScopeGateCandidates(parts: string[], normalized: string): string[] {
  const [, owner = "", child = "", leaf = ""] = parts;

  if (normalized === "docs/README.md" || normalized === "docs/contracts/README.md") {
    return ["docs-index", "repo-governance", "ops", "repo"];
  }

  if (normalized === "docs/contracts/documentation-system.md") {
    return ["documentation-system", "repo-governance", "ops", "repo"];
  }

  if (owner === "contracts" && child === "governance") {
    if (leaf === "command-surface.md") {
      return ["command-surface", "repo-governance", "ops", "repo"];
    }
    if (leaf === "task-scope.md" || leaf === "workflow.md") {
      return ["task-governance", "ops", "repo"];
    }
    return ["repo-governance", "ops", "repo"];
  }

  if (owner === "generated") {
    return ["generated-tooling", "ops", "repo"];
  }

  if (owner === "contracts" || ["guides", "references", "runbooks", "aliases"].includes(owner)) {
    return ["repo-governance", "ops", "repo"];
  }

  return ["repo-governance", "ops", "repo"];
}

function toolsScopeGateCandidates(parts: string[], normalized: string): string[] {
  const [, owner = "", child = ""] = parts;

  if (owner === "repoctl") {
    return ["repoctl", "ops", "repo"];
  }

  if (owner === "generated") {
    return ["generated-tooling", "ops", "repo"];
  }

  if (owner === "scanners") {
    return ["repo-policy", "ops", "repo"];
  }

  // Repoctl owns bounded task issue catalog/materialization helpers even when
  // they currently live under tools/core.
  if (
    owner === "core" &&
    (normalized === "tools/core/task-issue-catalog.ts" ||
      normalized === "tools/core/task-issue-catalog.test.ts")
  ) {
    return ["repoctl", "ops", "repo"];
  }

  if (["core", "contracts"].includes(owner)) {
    return ["task-governance", "ops", "repo"];
  }

  if (owner === "orchestrator") {
    if (child === "pr") return ["publish", "ops", "repo"];
    if (child === "task") return ["task-governance", "ops", "repo"];
    return ["task-governance", "ops", "repo"];
  }

  return ["ops", "repo"];
}

export function resolveScopeGateKeyCandidates(pathPattern: string): string[] {
  const normalized = normalizeScopePath(pathPattern);
  if (!normalized) return [];

  const parts = normalized.split("/").filter(Boolean);
  const [root = "", owner = "", child = ""] = parts;
  if (!root) return [];

  if (root === "apps") {
    if (owner === "api") return ["api", "apps", "repo"];
    if (owner === "app") return ["app", "apps", "repo"];
    if (owner === "platform-admin") return ["platform-admin", "apps", "repo"];
    if (owner === "public-docs") return ["public-docs", "apps", "repo"];
    if (owner === "worker") return ["worker", "apps", "repo"];
    if (owner === "agent-runner") return ["agent-runner", "worker", "apps", "repo"];
    if (owner === "agent-session-runtime") {
      return ["agent-session-runtime", "worker", "apps", "repo"];
    }
    return pickOwnerScopedKey(root, owner);
  }

  if (root === "apps-oss" || root === "packages" || root === "domains" || root === "processes") {
    return pickOwnerScopedKey(root, owner);
  }

  if (root === "docs") {
    return docsScopeGateCandidates(parts, normalized);
  }

  if (root === "platform" && owner === "dev" && ["local", "worktree"].includes(child)) {
    return ["worktree-runtime", "ops", "repo"];
  }

  if (root === "platform" && owner === "delivery" && child === "ci") {
    return ["delivery-ci", "ops", "repo"];
  }

  if (root === "platform" && owner === "delivery" && child === "gitops") {
    return ["gitops", "ops", "repo"];
  }

  if (root === "tools") {
    return toolsScopeGateCandidates(parts, normalized);
  }

  if (root === "scripts") {
    return scriptScopeGateCandidates(owner);
  }

  if (["tools", "scripts", "docs", "platform", ".github"].includes(root)) {
    return ["ops", "repo"];
  }

  if (
    [
      "package.json",
      "bun.lock",
      "bun.lock",
      "yarn.lock",
      "package-lock.json",
      "tsconfig.json",
      "tsconfig.base.json",
      "biome.json",
      "biome.jsonc",
      "turbo.json",
      "Cargo.toml",
      "Cargo.lock",
    ].includes(root)
  ) {
    return ["repo"];
  }

  return ["repo"];
}

export function resolveTaskScopeGateKeys(options: {
  allowedFiles: string[];
  availableKeys?: string[];
}): string[] {
  const availableKeySet = new Set(
    (options.availableKeys || [])
      .map((value) =>
        String(value || "")
          .trim()
          .toLowerCase()
      )
      .filter(Boolean)
  );
  const resolved: string[] = [];

  for (const allowedFile of options.allowedFiles) {
    const candidates = resolveScopeGateKeyCandidates(allowedFile);
    if (candidates.length === 0) continue;
    const selected = selectScopeGateKey(candidates, availableKeySet);
    if (!selected) continue;
    if (!resolved.includes(selected)) {
      resolved.push(selected);
    }
  }

  return resolved;
}

export function resolveSerializedScopeKeys(
  scopeGateKeys: string[],
  contractMap: Record<string, string>
): string[] {
  const resolved: string[] = [];

  for (const scopeGateKey of scopeGateKeys) {
    const serializedScopeKey =
      String(contractMap[scopeGateKey] || "").trim() ||
      (scopeGateKey.startsWith("apps/") ||
      scopeGateKey.startsWith("apps-oss/") ||
      scopeGateKey.startsWith("packages/") ||
      scopeGateKey.startsWith("domains/") ||
      scopeGateKey.startsWith("processes/")
        ? scopeGateKey.replace(/\//g, "_")
        : scopeGateKey);
    if (!serializedScopeKey || resolved.includes(serializedScopeKey)) continue;
    resolved.push(serializedScopeKey);
  }

  return resolved;
}
