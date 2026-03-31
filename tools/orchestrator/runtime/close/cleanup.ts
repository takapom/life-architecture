import { createHash } from "node:crypto";

import { fail, isObject, nowIsoUtc, parsePrNumberFromUrl } from "./common";
import type {
  CleanupPlan,
  CleanupPlanTarget,
  CleanupPlanTargetKind,
  CleanupPrTarget,
  CleanupResult,
  GateResultsPayload,
  ManagedWorktreeArchiveTarget,
  ManagedWorktreeDeleteTarget,
  ManagedWorktreeResidueSummary,
  RepoSafetySummary,
  RepoSafetyUnregisteredManagedDirClassification,
  StatePayload,
} from "./contracts";

export function buildManagedWorktreeResidueSummary(
  repoSafety: RepoSafetySummary
): ManagedWorktreeResidueSummary {
  return {
    generated_at: nowIsoUtc(),
    managed_worktree_root: repoSafety.managed_worktree_root,
    unregistered_managed_dir_count: repoSafety.unregistered_managed_dir_count,
    disposition_counts: repoSafety.unregistered_managed_dir_disposition_counts,
    items: repoSafety.unregistered_managed_dir_classifications,
    next_action: repoSafety.next_action,
  };
}

export function buildManagedWorktreeDeleteTargets(
  repoSafety: RepoSafetySummary
): ManagedWorktreeDeleteTarget[] {
  return [...repoSafety.unregistered_managed_dir_classifications]
    .filter(
      (
        entry
      ): entry is RepoSafetyUnregisteredManagedDirClassification & { disposition: "delete" } =>
        entry.disposition === "delete"
    )
    .sort((left, right) => left.worktree.localeCompare(right.worktree))
    .map((entry) => ({
      kind: "managed_worktree_delete",
      target_id: entry.dir_name,
      worktree_path: entry.worktree,
      disposition: "delete",
      reason: entry.reason,
    }));
}

export function buildManagedWorktreeArchiveTargets(
  repoSafety: RepoSafetySummary
): ManagedWorktreeArchiveTarget[] {
  return [...repoSafety.unregistered_managed_dir_classifications]
    .filter(
      (
        entry
      ): entry is RepoSafetyUnregisteredManagedDirClassification & {
        disposition: "rescue" | "broken_archive";
      } => entry.disposition === "rescue" || entry.disposition === "broken_archive"
    )
    .sort((left, right) => left.worktree.localeCompare(right.worktree))
    .map((entry) => ({
      kind: "managed_worktree_archive",
      target_id: entry.dir_name,
      worktree_path: entry.worktree,
      disposition: entry.disposition,
      reason: entry.reason,
    }));
}

export function summarizeManagedWorktreeArchiveDispositionCounts(
  targets: Array<Pick<ManagedWorktreeArchiveTarget, "disposition">>
): { rescue: number; broken_archive: number } {
  return targets.reduce(
    (counts, target) => {
      counts[target.disposition] += 1;
      return counts;
    },
    { rescue: 0, broken_archive: 0 }
  );
}

export function buildCleanupTargets(
  state: StatePayload,
  gate: GateResultsPayload
): CleanupPrTarget[] {
  const gateByNode = new Map(gate.nodes.map((entry) => [entry.node_id, entry]));
  const byPr = new Map<string, string>();
  const sortedNodes = Object.entries(state.nodes).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  for (const [taskId, node] of sortedNodes) {
    if (node.status !== "done" && node.status !== "merged") continue;
    const gateNode = gateByNode.get(taskId);
    const prUrl = String(gateNode?.pr_url || "").trim();
    const pr = parsePrNumberFromUrl(prUrl);
    if (!pr) {
      fail(`cleanup target requires valid pr_url for ${taskId}: ${prUrl || "(empty)"}`);
    }
    if (!byPr.has(pr)) {
      byPr.set(pr, taskId);
    }
  }

  return [...byPr.entries()]
    .map(([pr, taskId]) => ({ kind: "pr_cleanup", task_id: taskId, pr }))
    .sort((left, right) => {
      const leftNum = Number(left.pr);
      const rightNum = Number(right.pr);
      if (Number.isFinite(leftNum) && Number.isFinite(rightNum) && leftNum !== rightNum) {
        return leftNum - rightNum;
      }
      const byPr = left.pr.localeCompare(right.pr);
      if (byPr !== 0) return byPr;
      return left.task_id.localeCompare(right.task_id);
    });
}

export function buildCleanupPlan(options: {
  state: StatePayload;
  gate: GateResultsPayload;
  stateBackend: "github" | "local";
  repository: string;
  runIssueNumber: number;
  runId: string;
  baseBranch?: string;
  repoSafety?: RepoSafetySummary | null;
}): CleanupPlan {
  const prTargets = buildCleanupTargets(options.state, options.gate);
  const managedWorktreeDeleteTargets = options.repoSafety
    ? buildManagedWorktreeDeleteTargets(options.repoSafety)
    : [];
  const managedWorktreeArchiveTargets = options.repoSafety
    ? buildManagedWorktreeArchiveTargets(options.repoSafety)
    : [];
  const targets = [...prTargets, ...managedWorktreeDeleteTargets, ...managedWorktreeArchiveTargets];
  const digestInput = [
    String(options.stateBackend),
    String(options.repository),
    String(options.baseBranch || "main"),
    String(options.runIssueNumber),
    String(options.runId),
    ...targets.map((target) =>
      target.kind === "pr_cleanup"
        ? `${target.kind}:${target.task_id}:pr-${target.pr}`
        : `${target.kind}:${target.target_id}:${target.worktree_path}:${target.disposition}:${target.reason}`
    ),
  ].join("\n");
  const digest = createHash("sha256").update(digestInput).digest("hex").slice(0, 16);
  const managedArchiveDispositionCounts = summarizeManagedWorktreeArchiveDispositionCounts(
    managedWorktreeArchiveTargets
  );
  return {
    cleanup_plan_version: 1,
    generated_at: nowIsoUtc(),
    plan_id: `cp_${digest}`,
    state_backend: options.stateBackend,
    repository: options.repository,
    base_branch: String(options.baseBranch || "main").trim() || "main",
    run_issue_number: options.runIssueNumber,
    run_id: options.runId,
    target_count: targets.length,
    pr_target_count: prTargets.length,
    managed_worktree_delete_target_count: managedWorktreeDeleteTargets.length,
    managed_worktree_archive_target_count: managedWorktreeArchiveTargets.length,
    managed_worktree_archive_disposition_counts: managedArchiveDispositionCounts,
    targets,
  };
}

export function parseCleanupPlan(value: unknown): CleanupPlan {
  if (!isObject(value)) {
    fail("cleanup plan must be a JSON object");
  }
  const cleanupPlanVersion = Number(value.cleanup_plan_version || 0);
  if (cleanupPlanVersion !== 1) {
    fail("cleanup plan cleanup_plan_version must be 1");
  }
  const planId = String(value.plan_id || "").trim();
  if (!planId) {
    fail("cleanup plan plan_id is required");
  }
  const stateBackend = String(value.state_backend || "").trim() === "local" ? "local" : "github";
  const repository = String(value.repository || "").trim();
  if (!repository) {
    fail("cleanup plan repository is required");
  }
  const baseBranch = String(value.base_branch || "main").trim() || "main";
  const targetsRaw = Array.isArray(value.targets) ? value.targets : [];
  const targets: CleanupPlanTarget[] = [];
  const seenTarget = new Set<string>();
  for (const entry of targetsRaw) {
    if (!isObject(entry)) continue;
    const kindRaw = String(entry.kind || "").trim();
    let kind: CleanupPlanTargetKind = "pr_cleanup";
    if (kindRaw === "managed_worktree_delete") {
      kind = "managed_worktree_delete";
    } else if (kindRaw === "managed_worktree_archive") {
      kind = "managed_worktree_archive";
    }
    if (kind === "pr_cleanup") {
      const taskId = String(entry.task_id || "").trim();
      const pr = String(entry.pr || "").trim();
      if (!taskId || !pr) continue;
      const key = `${kind}::${taskId}::${pr}`;
      if (seenTarget.has(key)) continue;
      seenTarget.add(key);
      targets.push({ kind, task_id: taskId, pr });
      continue;
    }

    const targetId = String(entry.target_id || entry.task_id || "").trim();
    const worktreePath = String(entry.worktree_path || "").trim();
    const disposition = String(
      entry.disposition || (kind === "managed_worktree_delete" ? "delete" : "")
    ).trim();
    const reason = String(entry.reason || "").trim();
    if (!targetId || !worktreePath) continue;
    if (kind === "managed_worktree_delete") {
      if (disposition !== "delete") {
        fail(`managed worktree cleanup target must keep disposition=delete: ${targetId}`);
      }
      const key = `${kind}::${targetId}::${worktreePath}`;
      if (seenTarget.has(key)) continue;
      seenTarget.add(key);
      targets.push({
        kind,
        target_id: targetId,
        worktree_path: worktreePath,
        disposition: "delete",
        reason,
      });
      continue;
    }
    if (disposition !== "rescue" && disposition !== "broken_archive") {
      fail(
        `managed worktree archive target must keep disposition=rescue|broken_archive: ${targetId}`
      );
    }
    const key = `${kind}::${targetId}::${worktreePath}::${disposition}`;
    if (seenTarget.has(key)) continue;
    seenTarget.add(key);
    targets.push({
      kind,
      target_id: targetId,
      worktree_path: worktreePath,
      disposition,
      reason,
    });
  }
  const runIssueNumber = Number(value.run_issue_number || 0);
  if (!Number.isInteger(runIssueNumber) || runIssueNumber < 0) {
    fail("cleanup plan run_issue_number must be a non-negative integer");
  }
  const runId = String(value.run_id || "").trim();
  const prTargetCount = targets.filter((target) => target.kind === "pr_cleanup").length;
  const managedDeleteTargetCount = targets.filter(
    (target) => target.kind === "managed_worktree_delete"
  ).length;
  const managedArchiveTargets = targets.filter(
    (target): target is ManagedWorktreeArchiveTarget => target.kind === "managed_worktree_archive"
  );
  const managedArchiveDispositionCounts =
    summarizeManagedWorktreeArchiveDispositionCounts(managedArchiveTargets);
  return {
    cleanup_plan_version: 1,
    generated_at: String(value.generated_at || "").trim(),
    plan_id: planId,
    state_backend: stateBackend,
    repository,
    base_branch: baseBranch,
    run_issue_number: runIssueNumber,
    run_id: runId,
    target_count: targets.length,
    pr_target_count: prTargetCount,
    managed_worktree_delete_target_count: managedDeleteTargetCount,
    managed_worktree_archive_target_count: managedArchiveTargets.length,
    managed_worktree_archive_disposition_counts: managedArchiveDispositionCounts,
    targets,
  };
}

export function describeCleanupFailure(entry: CleanupResult): string {
  if (entry.kind === "managed_worktree_delete") {
    return `${entry.target_id} @ ${entry.worktree_path}: ${entry.detail}`;
  }
  if (entry.kind === "managed_worktree_archive") {
    const archivePath = entry.archive_path ? ` -> ${entry.archive_path}` : "";
    return `${entry.target_id} @ ${entry.worktree_path}${archivePath}: ${entry.detail}`;
  }
  return `pr#${entry.pr}: ${entry.detail}`;
}

export function buildPlannedCleanupResult(target: CleanupPlanTarget): CleanupResult {
  if (target.kind === "managed_worktree_delete") {
    return {
      kind: target.kind,
      target_id: target.target_id,
      task_id: target.target_id,
      pr: "",
      worktree_path: target.worktree_path,
      ok: true,
      detail: "planned(--not-applied)",
    };
  }
  if (target.kind === "managed_worktree_archive") {
    return {
      kind: target.kind,
      target_id: target.target_id,
      task_id: target.target_id,
      pr: "",
      worktree_path: target.worktree_path,
      archive_path: "",
      ok: true,
      detail: "planned(--not-applied)",
    };
  }
  return {
    kind: target.kind,
    target_id: target.task_id,
    task_id: target.task_id,
    pr: target.pr,
    worktree_path: "",
    ok: true,
    detail: "planned(--not-applied)",
  };
}
