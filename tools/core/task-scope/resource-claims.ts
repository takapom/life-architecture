import { normalizePathPattern } from "../issue-graph-types";
import { overlapsPathPattern } from "../path-patterns";
import type { TaskScopeResourceClaim, TaskScopeResourceClaimMode } from "./types";

const TASK_SCOPE_RESOURCE_CLAIM_RULES = [
  {
    mode: "exclusive",
    patterns: [
      "tools/core/task-scope.ts",
      "tools/core/task-scope/**",
      "platform/dev/worktree/task-pr-steady-state.ts",
      "platform/delivery/ci/local-pre-push.ts",
      "tools/apps/task/check-task-pr-steady-state.ts",
    ],
    resource: "task-scope-policy-engine",
  },
  {
    mode: "exclusive",
    patterns: [
      "tools/orchestrator/runtime/export-execution-plan.ts",
      "tools/orchestrator/runtime/execution-plan-contract.ts",
      "tools/orchestrator/src/runtime_contract.rs",
    ],
    resource: "execution-plan-writer",
  },
  {
    mode: "exclusive",
    patterns: [
      "platform/dev/local/start-codex.ts",
      "platform/dev/worktree/codex-write-scope.ts",
      "platform/dev/worktree/worktree-topology.ts",
    ],
    resource: "codex-launch-contract",
  },
  {
    mode: "exclusive",
    patterns: [
      "platform/dev/worktree/task-pr-steady-state.ts",
      "tools/apps/task/check-task-pr-steady-state.ts",
      "platform/dev/worktree/task-worktree-protection.ts",
    ],
    resource: "main-worktree-guard",
  },
  {
    mode: "exclusive",
    patterns: ["tools/core/task-scope/verify-cache.ts", "platform/delivery/ci/local-pre-push.ts"],
    resource: "verify-cache-writer",
  },
  {
    mode: "exclusive",
    patterns: [
      "tools/adapters/rust-runtime.ts",
      "tools/repoctl/**",
      "scripts/check-managed-rust-runtime.ts",
      "platform/dev/local/**",
    ],
    resource: "managed-rust-runtime",
  },
] as const satisfies ReadonlyArray<{
  mode: TaskScopeResourceClaimMode;
  patterns: readonly string[];
  resource: string;
}>;

function normalizeClaimMode(value: string): TaskScopeResourceClaimMode | null {
  if (value === "exclusive" || value === "shared-read" || value === "shared-write-forbidden") {
    return value;
  }
  return null;
}

function normalizeClaimResource(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase();
}

export function compareTaskScopeResourceClaims(
  candidateClaims: readonly TaskScopeResourceClaim[],
  otherClaims: readonly TaskScopeResourceClaim[]
): {
  candidateClaimMode: TaskScopeResourceClaimMode;
  otherClaimMode: TaskScopeResourceClaimMode;
  resource: string;
} | null {
  for (const candidateClaim of candidateClaims) {
    for (const otherClaim of otherClaims) {
      if (candidateClaim.resource !== otherClaim.resource) continue;
      if (candidateClaim.mode === "exclusive" || otherClaim.mode === "exclusive") {
        return {
          candidateClaimMode: candidateClaim.mode,
          otherClaimMode: otherClaim.mode,
          resource: candidateClaim.resource,
        };
      }
    }
  }
  return null;
}

export function deriveTaskScopeResourceClaims(
  allowedFiles: readonly string[]
): TaskScopeResourceClaim[] {
  const allowedGlobs = [
    ...new Set(allowedFiles.map((value) => normalizePathPattern(value)).filter(Boolean)),
  ];
  const claims = new Map<string, TaskScopeResourceClaim>();

  for (const rule of TASK_SCOPE_RESOURCE_CLAIM_RULES) {
    const matches = allowedGlobs.some((allowedGlob) =>
      rule.patterns.some((pattern) => overlapsPathPattern(allowedGlob, pattern))
    );
    if (!matches) continue;
    claims.set(rule.resource, {
      mode: rule.mode,
      resource: rule.resource,
    });
  }

  return [...claims.values()].sort((left, right) => left.resource.localeCompare(right.resource));
}

export function normalizeTaskScopeResourceClaims(raw: unknown): TaskScopeResourceClaim[] | null {
  if (!Array.isArray(raw)) return null;
  const claims = new Map<string, TaskScopeResourceClaim>();

  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return null;
    }
    const claim = entry as Record<string, unknown>;
    const resource = normalizeClaimResource(claim.resource);
    const mode = normalizeClaimMode(String(claim.mode || "").trim());
    if (!resource || !mode) {
      return null;
    }
    claims.set(resource, { mode, resource });
  }

  return [...claims.values()].sort((left, right) => left.resource.localeCompare(right.resource));
}

export function resourceClaimsEqual(
  left: readonly TaskScopeResourceClaim[],
  right: readonly TaskScopeResourceClaim[]
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (claim, index) =>
        claim.resource === right[index]?.resource && claim.mode === right[index]?.mode
    )
  );
}
