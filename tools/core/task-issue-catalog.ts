import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  loadCanonicalTaskIssueSummariesFromFile,
  loadTaskIssuesFromSourceNodes,
  resolveCanonicalTaskIssueSourcePath,
} from "../adapters/issue-graph-fetch";
import { runRepoctlControlPlaneTaskIssueEnsure } from "../repoctl/runtime";
import type { RepositoryRef, TaskIssue } from "./issue-graph-types";
import { resolveRepository } from "./issue-graph-types";
import type { GraphIssueNode } from "./task-governance";
import { normalizeTaskId } from "./task-issue-guard";

export type CanonicalTaskIssueSummary = {
  htmlUrl: string;
  number: number;
  state: "OPEN" | "CLOSED";
  taskId: string;
  title: string;
};

export type RepoTaskIssueCatalogSummary = {
  body: string;
  htmlUrl: string;
  metadata: {
    acceptance_checks: string[];
    admission_mode: string;
    allowed_files: string[];
    deps: string[];
    global_invariant: string;
    task_id: string;
    tests: string[];
    unfreeze_condition: string;
  };
  number: number;
  state: "OPEN" | "CLOSED";
  taskId: string;
  title: string;
};

export type RepoTaskIssueCatalogSnapshot = {
  version: 1;
  repository: string;
  state: "all";
  generated_at: string;
  max_age_ms: number;
  issue_count: number;
  source_fingerprint: string;
  issues: RepoTaskIssueCatalogSummary[];
};

export const REPO_TASK_ISSUE_CATALOG_SNAPSHOT_VERSION = 1;
export const DEFAULT_REPO_TASK_ISSUE_CATALOG_MAX_AGE_MS = 60 * 60 * 1000;

type CanonicalTaskIssueRepairDependencies = {
  loadTaskIssueByTaskIdFromControlPlane: (options: {
    issueNumber?: number;
    repository: string | RepositoryRef;
    state?: "all" | "open";
    taskId: string;
  }) => Promise<{
    issue: TaskIssue;
    repository: RepositoryRef;
  }>;
  readCurrentRepoTaskIssueCatalogSnapshot: typeof readCurrentRepoTaskIssueCatalogSnapshot;
};

type RepoTaskIssueCatalogSummaryRepairDependencies = {
  loadTaskIssueByTaskIdFromControlPlane: CanonicalTaskIssueRepairDependencies["loadTaskIssueByTaskIdFromControlPlane"];
};

function normalizeCanonicalTaskIssueSummary(
  issue: CanonicalTaskIssueSummary
): CanonicalTaskIssueSummary | null {
  const taskId = normalizeTaskId(issue.taskId);
  const number = Number(issue.number || 0);
  let state = "";
  if (issue.state === "CLOSED") {
    state = "CLOSED";
  } else if (issue.state === "OPEN") {
    state = "OPEN";
  }
  if (!taskId || !Number.isInteger(number) || number <= 0 || !state) {
    return null;
  }
  return {
    htmlUrl: String(issue.htmlUrl || "").trim(),
    number,
    state,
    taskId,
    title: String(issue.title || "").trim(),
  };
}

function normalizeCanonicalTaskIssueSummaries(
  issues: ReadonlyArray<CanonicalTaskIssueSummary>
): CanonicalTaskIssueSummary[] {
  const issuesByNumber = new Map<number, CanonicalTaskIssueSummary>();
  for (const rawIssue of issues) {
    const issue = normalizeCanonicalTaskIssueSummary(rawIssue);
    if (!issue) {
      continue;
    }
    issuesByNumber.set(issue.number, issue);
  }
  return [...issuesByNumber.values()].sort((left, right) => left.number - right.number);
}

function normalizeRepositorySlug(repository: string): string {
  const resolved = resolveRepository(String(repository || "").trim());
  return `${resolved.owner}/${resolved.repo}`;
}

function normalizeCatalogIssue(
  issue: RepoTaskIssueCatalogSummary
): RepoTaskIssueCatalogSummary | null {
  const taskId = normalizeTaskId(issue.taskId);
  const number = Number(issue.number || 0);
  let state = "";
  if (issue.state === "CLOSED") {
    state = "CLOSED";
  } else if (issue.state === "OPEN") {
    state = "OPEN";
  }
  if (!taskId || !Number.isInteger(number) || number <= 0 || !state) {
    return null;
  }
  return {
    body: String(issue.body || ""),
    htmlUrl: String(issue.htmlUrl || "").trim(),
    metadata: {
      acceptance_checks: Array.isArray(issue.metadata?.acceptance_checks)
        ? issue.metadata.acceptance_checks
            .map((value) => String(value || "").trim())
            .filter(Boolean)
        : [],
      admission_mode: String(issue.metadata?.admission_mode || "").trim(),
      allowed_files: Array.isArray(issue.metadata?.allowed_files)
        ? issue.metadata.allowed_files.map((value) => String(value || "").trim()).filter(Boolean)
        : [],
      deps: Array.isArray(issue.metadata?.deps)
        ? issue.metadata.deps.map((value) => String(value || "").trim()).filter(Boolean)
        : [],
      global_invariant: String(issue.metadata?.global_invariant || "").trim(),
      task_id: taskId,
      tests: Array.isArray(issue.metadata?.tests)
        ? issue.metadata.tests.map((value) => String(value || "").trim()).filter(Boolean)
        : [],
      unfreeze_condition: String(issue.metadata?.unfreeze_condition || "").trim(),
    },
    number,
    state,
    taskId,
    title: String(issue.title || "").trim(),
  };
}

function normalizeCatalogIssues(
  issues: ReadonlyArray<RepoTaskIssueCatalogSummary>
): RepoTaskIssueCatalogSummary[] {
  const issuesByNumber = new Map<number, RepoTaskIssueCatalogSummary>();
  for (const rawIssue of issues) {
    const issue = normalizeCatalogIssue(rawIssue);
    if (!issue) {
      continue;
    }
    issuesByNumber.set(issue.number, issue);
  }
  return [...issuesByNumber.values()].sort((left, right) => left.number - right.number);
}

function toRepoTaskIssueCatalogSummary(issue: {
  body: string;
  htmlUrl: string;
  metadata: RepoTaskIssueCatalogSummary["metadata"];
  number: number;
  state: "OPEN" | "CLOSED";
  taskId: string;
  title: string;
}): RepoTaskIssueCatalogSummary | null {
  return normalizeCatalogIssue({
    body: issue.body,
    htmlUrl: issue.htmlUrl,
    metadata: issue.metadata,
    number: issue.number,
    state: issue.state,
    taskId: issue.taskId,
    title: issue.title,
  });
}

function buildCatalogSourceFingerprint(input: {
  repository: string;
  issues: ReadonlyArray<RepoTaskIssueCatalogSummary>;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        issues: input.issues.map((issue) => ({
          body: issue.body,
          htmlUrl: issue.htmlUrl,
          metadata: {
            acceptance_checks: issue.metadata.acceptance_checks,
            admission_mode: issue.metadata.admission_mode,
            allowed_files: issue.metadata.allowed_files,
            deps: issue.metadata.deps,
            global_invariant: issue.metadata.global_invariant,
            task_id: issue.metadata.task_id,
            tests: issue.metadata.tests,
            unfreeze_condition: issue.metadata.unfreeze_condition,
          },
          number: issue.number,
          state: issue.state,
          taskId: issue.taskId,
          title: issue.title,
        })),
        repository: input.repository,
        state: "all",
      })
    )
    .digest("hex");
}

export function renderRepoTaskIssueCatalogRefreshCommand(repository: string): string {
  return `bun run task:ensure -- --repository ${normalizeRepositorySlug(repository)} --repo-wide-catalog --source <canonical-issue-graph.json>`;
}

export function repoTaskIssueCatalogSnapshotRelativePath(repository: string): string {
  const normalizedRepository = normalizeRepositorySlug(repository);
  return path.posix.join(
    "omta",
    "task-issue-catalogs",
    `${normalizedRepository.replaceAll("/", "__")}.json`
  );
}

function resolveGitCommonPath(repoRoot: string, relativePath: string): string {
  const result = spawnSync("git", ["-C", repoRoot, "rev-parse", "--git-common-dir"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const detail = `${result.stderr || ""}\n${result.stdout || ""}`.trim();
    throw new Error(`git rev-parse --git-common-dir failed: ${detail || `exit=${result.status}`}`);
  }
  const gitCommonDir = String(result.stdout || "").trim();
  if (!gitCommonDir) {
    throw new Error("git rev-parse --git-common-dir returned an empty path");
  }
  const absoluteGitCommonDir = path.isAbsolute(gitCommonDir)
    ? gitCommonDir
    : path.resolve(repoRoot, gitCommonDir);
  return path.join(absoluteGitCommonDir, relativePath);
}

export function resolveRepoTaskIssueCatalogSnapshotPath(
  repoRoot: string,
  repository: string
): string {
  return resolveGitCommonPath(repoRoot, repoTaskIssueCatalogSnapshotRelativePath(repository));
}

function isValidGeneratedAt(value: string): boolean {
  return !Number.isNaN(Date.parse(String(value || "").trim()));
}

function isRepoTaskIssueCatalogSnapshotShape(
  snapshot: Partial<RepoTaskIssueCatalogSnapshot> | null | undefined
): snapshot is RepoTaskIssueCatalogSnapshot {
  if (!snapshot || snapshot.version !== REPO_TASK_ISSUE_CATALOG_SNAPSHOT_VERSION) {
    return false;
  }

  if (
    typeof snapshot.repository !== "string" ||
    snapshot.state !== "all" ||
    typeof snapshot.generated_at !== "string" ||
    !isValidGeneratedAt(snapshot.generated_at) ||
    !Number.isInteger(snapshot.max_age_ms) ||
    snapshot.max_age_ms <= 0 ||
    typeof snapshot.source_fingerprint !== "string" ||
    !snapshot.source_fingerprint.trim() ||
    !Array.isArray(snapshot.issues)
  ) {
    return false;
  }

  const issues = normalizeCatalogIssues(snapshot.issues);
  return issues.length === snapshot.issues.length && snapshot.issue_count === issues.length;
}

export function readRepoTaskIssueCatalogSnapshot(
  repoRoot: string,
  repository: string
): RepoTaskIssueCatalogSnapshot | null {
  const snapshotPath = resolveRepoTaskIssueCatalogSnapshotPath(repoRoot, repository);
  if (!existsSync(snapshotPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      readFileSync(snapshotPath, "utf8")
    ) as Partial<RepoTaskIssueCatalogSnapshot>;
    if (!isRepoTaskIssueCatalogSnapshotShape(parsed)) {
      return null;
    }

    const normalizedRepository = normalizeRepositorySlug(repository);
    if (normalizeRepositorySlug(parsed.repository) !== normalizedRepository) {
      return null;
    }

    const issues = normalizeCatalogIssues(parsed.issues);
    const sourceFingerprint = buildCatalogSourceFingerprint({
      repository: normalizedRepository,
      issues,
    });
    if (parsed.source_fingerprint !== sourceFingerprint) {
      return null;
    }

    return {
      ...parsed,
      issue_count: issues.length,
      issues,
      repository: normalizedRepository,
    };
  } catch {
    return null;
  }
}

export function isRepoTaskIssueCatalogSnapshotCurrent(
  snapshot: RepoTaskIssueCatalogSnapshot | null,
  options: {
    maxAgeMs?: number;
    now?: Date | number | string;
    repository: string;
  }
): boolean {
  if (!snapshot) {
    return false;
  }

  const normalizedRepository = normalizeRepositorySlug(options.repository);
  const nowValue = options.now ?? Date.now();
  let nowMs = Number.NaN;
  if (typeof nowValue === "number") {
    nowMs = nowValue;
  } else if (typeof nowValue === "string") {
    nowMs = Date.parse(nowValue);
  } else {
    nowMs = nowValue.getTime();
  }
  const generatedAtMs = Date.parse(snapshot.generated_at);
  const maxAgeMs = Number(options.maxAgeMs || snapshot.max_age_ms || 0);

  return (
    snapshot.version === REPO_TASK_ISSUE_CATALOG_SNAPSHOT_VERSION &&
    snapshot.repository === normalizedRepository &&
    snapshot.state === "all" &&
    Number.isFinite(nowMs) &&
    Number.isFinite(generatedAtMs) &&
    Number.isInteger(maxAgeMs) &&
    maxAgeMs > 0 &&
    nowMs - generatedAtMs <= maxAgeMs
  );
}

export function materializeRepoTaskIssueCatalogSnapshot(options: {
  generatedAt?: string;
  issues: ReadonlyArray<RepoTaskIssueCatalogSummary>;
  maxAgeMs?: number;
  repoRoot: string;
  repository: string;
}): {
  snapshot: RepoTaskIssueCatalogSnapshot;
  snapshotPath: string;
} {
  const repository = normalizeRepositorySlug(options.repository);
  const issues = normalizeCatalogIssues(options.issues);
  const generatedAt = String(options.generatedAt || new Date().toISOString()).trim();
  const maxAgeMs = Number(options.maxAgeMs || DEFAULT_REPO_TASK_ISSUE_CATALOG_MAX_AGE_MS);
  const snapshot: RepoTaskIssueCatalogSnapshot = {
    version: REPO_TASK_ISSUE_CATALOG_SNAPSHOT_VERSION,
    repository,
    state: "all",
    generated_at: generatedAt,
    max_age_ms: maxAgeMs,
    issue_count: issues.length,
    source_fingerprint: buildCatalogSourceFingerprint({
      repository,
      issues,
    }),
    issues,
  };
  const snapshotPath = resolveRepoTaskIssueCatalogSnapshotPath(options.repoRoot, repository);
  mkdirSync(path.dirname(snapshotPath), { recursive: true });
  writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  return { snapshot, snapshotPath };
}

export function overlayRepoTaskIssueCatalogIssues(options: {
  baseIssues: ReadonlyArray<RepoTaskIssueCatalogSummary>;
  refreshedIssues: ReadonlyArray<RepoTaskIssueCatalogSummary>;
}): RepoTaskIssueCatalogSummary[] {
  return normalizeCatalogIssues([...options.baseIssues, ...options.refreshedIssues]);
}

export function selectRepoTaskIssueCatalogSummaries(
  taskIssues: ReadonlyArray<RepoTaskIssueCatalogSummary>,
  taskIds: Iterable<string>
): RepoTaskIssueCatalogSummary[] {
  const requestedTaskIds = [
    ...new Set([...taskIds].map((taskId) => normalizeTaskId(taskId)).filter(Boolean)),
  ];
  if (requestedTaskIds.length === 0) {
    return [];
  }
  return normalizeCatalogIssues(
    taskIssues.filter((issue) => requestedTaskIds.includes(normalizeTaskId(issue.taskId)))
  );
}

export function readBoundedRepoTaskIssueCatalogSummariesForTaskIds(
  taskIds: Iterable<string>,
  sourcePath?: string
): { issues: RepoTaskIssueCatalogSummary[]; missingTaskIds: string[] } {
  const requestedTaskIds = [
    ...new Set([...taskIds].map((taskId) => normalizeTaskId(taskId)).filter(Boolean)),
  ];
  if (requestedTaskIds.length === 0) {
    return { issues: [], missingTaskIds: [] };
  }

  const resolvedSourcePath = resolveCanonicalTaskIssueSourcePath(sourcePath);
  if (!resolvedSourcePath) {
    return {
      issues: [],
      missingTaskIds: requestedTaskIds,
    };
  }

  const issues = normalizeCatalogIssues(
    loadCanonicalTaskIssueSummariesFromFile(resolvedSourcePath)
      .issues.filter((issue) => requestedTaskIds.includes(normalizeTaskId(issue.taskId)))
      .map((issue) =>
        toRepoTaskIssueCatalogSummary({
          body: issue.body,
          htmlUrl: issue.htmlUrl,
          metadata: issue.metadata,
          number: issue.number,
          state: issue.state,
          taskId: issue.taskId,
          title: issue.title,
        })
      )
      .filter((issue): issue is RepoTaskIssueCatalogSummary => issue !== null)
  );
  const resolvedTaskIds = new Set(issues.map((issue) => normalizeTaskId(issue.taskId)));
  return {
    issues,
    missingTaskIds: requestedTaskIds.filter((taskId) => !resolvedTaskIds.has(taskId)),
  };
}

export function overlayCanonicalTaskIssueSummaries(options: {
  baseIssues: ReadonlyArray<CanonicalTaskIssueSummary>;
  refreshedIssues: ReadonlyArray<CanonicalTaskIssueSummary>;
}): CanonicalTaskIssueSummary[] {
  return normalizeCanonicalTaskIssueSummaries([...options.baseIssues, ...options.refreshedIssues]);
}

export function selectCanonicalTaskIssueSummaries(
  taskIssues: ReadonlyArray<CanonicalTaskIssueSummary>,
  taskIds: Iterable<string>
): CanonicalTaskIssueSummary[] {
  const requestedTaskIds = [
    ...new Set([...taskIds].map((taskId) => normalizeTaskId(taskId)).filter(Boolean)),
  ];
  if (requestedTaskIds.length === 0) {
    return [];
  }
  return normalizeCanonicalTaskIssueSummaries(
    taskIssues.filter((issue) => requestedTaskIds.includes(normalizeTaskId(issue.taskId)))
  );
}

export function readBoundedCanonicalTaskIssueSummariesForTaskIds(
  taskIds: Iterable<string>,
  sourcePath?: string
): { issues: CanonicalTaskIssueSummary[]; missingTaskIds: string[] } {
  const requestedTaskIds = [
    ...new Set([...taskIds].map((taskId) => normalizeTaskId(taskId)).filter(Boolean)),
  ];
  if (requestedTaskIds.length === 0) {
    return { issues: [], missingTaskIds: [] };
  }

  const resolvedSourcePath = resolveCanonicalTaskIssueSourcePath(sourcePath);
  if (!resolvedSourcePath) {
    return {
      issues: [],
      missingTaskIds: requestedTaskIds,
    };
  }

  const issues = normalizeCanonicalTaskIssueSummaries(
    loadCanonicalTaskIssueSummariesFromFile(resolvedSourcePath)
      .issues.filter((issue) => requestedTaskIds.includes(normalizeTaskId(issue.taskId)))
      .map((issue) => ({
        htmlUrl: issue.htmlUrl,
        number: issue.number,
        state: issue.state,
        taskId: issue.taskId,
        title: issue.title,
      }))
  );
  const resolvedTaskIds = new Set(issues.map((issue) => normalizeTaskId(issue.taskId)));
  return {
    issues,
    missingTaskIds: requestedTaskIds.filter((taskId) => !resolvedTaskIds.has(taskId)),
  };
}

function isCanonicalTaskIssueMissingError(error: unknown): boolean {
  const message = String((error as Error)?.message || "");
  return (
    message.startsWith("no open GitHub task issue found for ") ||
    message.startsWith("no canonical GitHub task issue found for ")
  );
}

function renderMissingTaskIssueSourceError(taskIds: ReadonlyArray<string>): string {
  return `task/PR steady-state requires canonical issue snapshots for ${taskIds.join(", ")} via OMTA_TASK_ISSUE_SOURCE or ISSUE_GRAPH_SOURCE; live GitHub task issue enumeration is retired`;
}

const DEFAULT_CANONICAL_TASK_ISSUE_REPAIR_DEPENDENCIES: CanonicalTaskIssueRepairDependencies = {
  loadTaskIssueByTaskIdFromControlPlane: ({ issueNumber, repository, state, taskId }) => {
    const repositorySlug =
      typeof repository === "string" ? repository : `${repository.owner}/${repository.repo}`;
    const ensured = runRepoctlControlPlaneTaskIssueEnsure({
      issueNumber,
      repository: repositorySlug,
      state,
      taskId,
    });
    const loaded = loadTaskIssuesFromSourceNodes(
      [ensured.issue as GraphIssueNode],
      repositorySlug,
      { state }
    );
    const issue = loaded.issues[0];
    if (!issue) {
      throw new Error(`repoctl task-issue ensure returned no canonical issue for ${taskId}`);
    }
    return {
      issue,
      repository: loaded.repository,
    };
  },
  readCurrentRepoTaskIssueCatalogSnapshot,
};

const DEFAULT_REPO_TASK_ISSUE_CATALOG_SUMMARY_REPAIR_DEPENDENCIES: RepoTaskIssueCatalogSummaryRepairDependencies =
  {
    loadTaskIssueByTaskIdFromControlPlane:
      DEFAULT_CANONICAL_TASK_ISSUE_REPAIR_DEPENDENCIES.loadTaskIssueByTaskIdFromControlPlane,
  };

export async function resolveCanonicalTaskIssueSummariesWithRepair(
  options: {
    repoRoot: string;
    repository: string;
    sourcePath?: string;
    taskIds: Iterable<string>;
  },
  dependencies: CanonicalTaskIssueRepairDependencies = DEFAULT_CANONICAL_TASK_ISSUE_REPAIR_DEPENDENCIES
): Promise<CanonicalTaskIssueSummary[]> {
  const requestedTaskIds = [
    ...new Set([...options.taskIds].map((taskId) => normalizeTaskId(taskId)).filter(Boolean)),
  ].sort((left, right) => left.localeCompare(right));
  if (requestedTaskIds.length === 0) {
    return [];
  }

  const bounded = readBoundedCanonicalTaskIssueSummariesForTaskIds(
    requestedTaskIds,
    options.sourcePath
  );
  let taskIssues = bounded.issues;
  let missingTaskIds = bounded.missingTaskIds;

  if (missingTaskIds.length > 0) {
    try {
      const repoWideSnapshot = dependencies.readCurrentRepoTaskIssueCatalogSnapshot(
        options.repoRoot,
        options.repository
      );
      taskIssues = overlayCanonicalTaskIssueSummaries({
        baseIssues: taskIssues,
        refreshedIssues: selectCanonicalTaskIssueSummaries(repoWideSnapshot.issues, missingTaskIds),
      });
      missingTaskIds = requestedTaskIds.filter(
        (taskId) => !taskIssues.some((issue) => normalizeTaskId(issue.taskId) === taskId)
      );
    } catch {
      // Scoped repair prefers the current catalog when available but does not fail if the
      // projection is unavailable and targeted control-plane rehydration can still recover.
    }
  }

  if (missingTaskIds.length > 0) {
    const refreshedIssues: CanonicalTaskIssueSummary[] = [];
    for (const taskId of missingTaskIds) {
      try {
        const payload = await dependencies.loadTaskIssueByTaskIdFromControlPlane({
          repository: options.repository,
          state: "all",
          taskId,
        });
        refreshedIssues.push({
          htmlUrl: payload.issue.htmlUrl,
          number: payload.issue.number,
          state: payload.issue.state === "closed" ? "CLOSED" : "OPEN",
          taskId,
          title: payload.issue.title,
        });
      } catch (error) {
        if (isCanonicalTaskIssueMissingError(error)) {
          continue;
        }
        throw error;
      }
    }
    taskIssues = overlayCanonicalTaskIssueSummaries({
      baseIssues: taskIssues,
      refreshedIssues,
    });
    missingTaskIds = requestedTaskIds.filter(
      (taskId) => !taskIssues.some((issue) => normalizeTaskId(issue.taskId) === taskId)
    );
  }

  if (missingTaskIds.length > 0) {
    throw new Error(renderMissingTaskIssueSourceError(missingTaskIds));
  }

  return taskIssues;
}

export async function resolveRepoTaskIssueCatalogSummariesWithRepair(
  options: {
    repoRoot: string;
    repository: string;
    sourcePath?: string;
    taskIds: Iterable<string>;
  },
  dependencies: RepoTaskIssueCatalogSummaryRepairDependencies = DEFAULT_REPO_TASK_ISSUE_CATALOG_SUMMARY_REPAIR_DEPENDENCIES
): Promise<RepoTaskIssueCatalogSummary[]> {
  const requestedTaskIds = [
    ...new Set([...options.taskIds].map((taskId) => normalizeTaskId(taskId)).filter(Boolean)),
  ].sort((left, right) => left.localeCompare(right));
  if (requestedTaskIds.length === 0) {
    return [];
  }

  const bounded = readBoundedRepoTaskIssueCatalogSummariesForTaskIds(
    requestedTaskIds,
    options.sourcePath
  );
  let taskIssues = bounded.issues;
  let missingTaskIds = bounded.missingTaskIds;

  if (missingTaskIds.length > 0) {
    const repoWideSnapshot = readRepoTaskIssueCatalogSnapshot(options.repoRoot, options.repository);
    if (repoWideSnapshot) {
      taskIssues = overlayRepoTaskIssueCatalogIssues({
        baseIssues: taskIssues,
        refreshedIssues: selectRepoTaskIssueCatalogSummaries(
          repoWideSnapshot.issues,
          missingTaskIds
        ),
      });
      missingTaskIds = requestedTaskIds.filter(
        (taskId) => !taskIssues.some((issue) => normalizeTaskId(issue.taskId) === taskId)
      );
    }
  }

  if (missingTaskIds.length > 0) {
    const refreshedIssues: RepoTaskIssueCatalogSummary[] = [];
    for (const taskId of missingTaskIds) {
      try {
        const payload = await dependencies.loadTaskIssueByTaskIdFromControlPlane({
          repository: options.repository,
          state: "all",
          taskId,
        });
        const refreshedIssue = toRepoTaskIssueCatalogSummary({
          body: "",
          htmlUrl: payload.issue.htmlUrl,
          metadata: {
            acceptance_checks: payload.issue.metadata.acceptance_checks,
            admission_mode: payload.issue.metadata.admission_mode,
            allowed_files: payload.issue.metadata.allowed_files,
            deps: payload.issue.metadata.deps,
            global_invariant: payload.issue.metadata.global_invariant,
            task_id: payload.issue.metadata.task_id,
            tests: payload.issue.metadata.tests,
            unfreeze_condition: payload.issue.metadata.unfreeze_condition,
          },
          number: payload.issue.number,
          state: payload.issue.state === "closed" ? "CLOSED" : "OPEN",
          taskId,
          title: payload.issue.title,
        });
        if (refreshedIssue) {
          refreshedIssues.push(refreshedIssue);
        }
      } catch (error) {
        if (isCanonicalTaskIssueMissingError(error)) {
          continue;
        }
        throw error;
      }
    }
    taskIssues = overlayRepoTaskIssueCatalogIssues({
      baseIssues: taskIssues,
      refreshedIssues,
    });
    missingTaskIds = requestedTaskIds.filter(
      (taskId) => !taskIssues.some((issue) => normalizeTaskId(issue.taskId) === taskId)
    );
  }

  if (missingTaskIds.length > 0) {
    throw new Error(renderMissingTaskIssueSourceError(missingTaskIds));
  }

  return taskIssues;
}

export function readCurrentRepoTaskIssueCatalogSnapshot(
  repoRoot: string,
  repository: string,
  options?: {
    maxAgeMs?: number;
    now?: Date | number | string;
  }
): RepoTaskIssueCatalogSnapshot {
  const snapshot = readRepoTaskIssueCatalogSnapshot(repoRoot, repository);
  if (
    isRepoTaskIssueCatalogSnapshotCurrent(snapshot, {
      maxAgeMs: options?.maxAgeMs,
      now: options?.now,
      repository,
    })
  ) {
    return snapshot as RepoTaskIssueCatalogSnapshot;
  }

  const refreshCommand = renderRepoTaskIssueCatalogRefreshCommand(repository);
  if (!snapshot) {
    throw new Error(
      `repo-wide steady-state requires a current canonical task issue catalog snapshot for ${normalizeRepositorySlug(repository)}. Refresh it with: ${refreshCommand}`
    );
  }

  throw new Error(
    `repo-wide steady-state task issue catalog snapshot for ${normalizeRepositorySlug(repository)} is stale (generated_at=${snapshot.generated_at}, max_age_ms=${snapshot.max_age_ms}). Refresh it with: ${refreshCommand}`
  );
}
