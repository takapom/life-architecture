import {
  resolveWorktreeBaseValues as resolveSharedWorktreeBaseValues,
  resolveWorktreeRuntimePlan as resolveSharedWorktreeRuntimePlan,
  resolveWorktreeRuntimeValues as resolveSharedWorktreeRuntimeValues,
  WORKTREE_RUNTIME_DEFAULTS as SHARED_WORKTREE_RUNTIME_DEFAULTS,
  type WorktreeRuntimeDynamicValuesInput,
  type WorktreeRuntimePlan,
  type WorktreeRuntimePlanOptions,
} from "../../contracts/local-runtime-contract.ts";

export type { WorktreeRuntimeDynamicValuesInput, WorktreeRuntimePlan, WorktreeRuntimePlanOptions };

export const WORKTREE_RUNTIME_DEFAULTS = SHARED_WORKTREE_RUNTIME_DEFAULTS;

export function resolveWorktreeRuntimePlan(
  options: WorktreeRuntimePlanOptions
): WorktreeRuntimePlan {
  return resolveSharedWorktreeRuntimePlan(options);
}

export function resolveWorktreeBaseValues() {
  return resolveSharedWorktreeBaseValues();
}

export function resolveWorktreeRuntimeValues(
  plan: WorktreeRuntimePlan,
  input: WorktreeRuntimeDynamicValuesInput
) {
  return resolveSharedWorktreeRuntimeValues(plan, input);
}
