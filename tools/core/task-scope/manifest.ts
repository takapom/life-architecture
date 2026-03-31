import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inspectCanonicalWorktreeActivity } from "../../../platform/dev/worktree/worktree-activity";
import {
  listCanonicalTaskWorktrees,
  resolveTaskScopeRootFromRepoRoot,
} from "../../../platform/dev/worktree/worktree-topology";
import { fail, parseJson, renderStopReasonDiagnostic } from "../../adapters/cli";
import {
  extractLabels,
  extractTaskIdFromIssueBody,
  type GraphIssueNode,
  normalizePathPattern,
  normalizeSourceIssue,
  parseIssueState,
  parseTaskMetadata,
  type TaskIssue,
  type TaskMetadata,
} from "../issue-graph-types";
import { tryBuildTaskScopeSnapshotFromIssueSnapshot } from "../task-issue-contract";
import {
  buildTaskIssueSourceFingerprint,
  detectRepositoryFromOrigin,
  extractTaskIdFromBranch,
  isTaskIssueSnapshotCurrent,
  normalizeTaskId,
  readTaskIssueSnapshot,
  resolveGitPath,
} from "../task-issue-guard";
import {
  deriveTaskScopeAdmissionClassification,
  detectTaskScopeAdmissionConflict,
} from "./derivation";
import { normalizeTaskScopeResourceClaims, resourceClaimsEqual } from "./resource-claims";
import {
  type IssueSnapshot,
  TASK_SCOPE_ADMISSION_MODES,
  TASK_SCOPE_CONFLICT_CLASSES,
  TASK_SCOPE_VERIFICATION_CLASSES,
  TASK_SCOPE_VERSION,
  type TaskScopeAdmissionMode,
  type TaskScopeConflict,
  type TaskScopeConflictClass,
  type TaskScopeManifest,
  type TaskScopeStopReason,
  type TaskScopeVerificationClass,
  TITLE_TASK_ID_RE,
} from "./types";

function isTaskScopeConflictClass(value: string): value is TaskScopeConflictClass {
  return (TASK_SCOPE_CONFLICT_CLASSES as readonly string[]).includes(value);
}

function isTaskScopeVerificationClass(value: string): value is TaskScopeVerificationClass {
  return (TASK_SCOPE_VERIFICATION_CLASSES as readonly string[]).includes(value);
}

function isTaskScopeAdmissionMode(value: string): value is TaskScopeAdmissionMode {
  return (TASK_SCOPE_ADMISSION_MODES as readonly string[]).includes(value);
}

function normalizeAdmissionMode(value: unknown): TaskScopeAdmissionMode {
  const normalized = String(value || "standard")
    .trim()
    .toLowerCase();
  if (normalized === "global-exclusive") return "global-exclusive";
  if (normalized === "landing-exclusive") return "landing-exclusive";
  return "standard";
}

function normalizeStringArray(
  raw: unknown,
  normalizeEntry: (value: string) => string
): string[] | null {
  if (!Array.isArray(raw)) return null;
  return [...new Set(raw.map((value) => normalizeEntry(String(value || ""))).filter(Boolean))];
}

function extractTaskIdFromTitle(title: string): string {
  return normalizeTaskId(String(title.match(TITLE_TASK_ID_RE)?.[1] || "").trim());
}

type CanonicalTaskIssueSnapshot = IssueSnapshot & {
  metadata: TaskMetadata;
  state: "OPEN" | "CLOSED";
};

export type CurrentTaskSessionArtifacts = {
  branch: string;
  manifest: TaskScopeManifest;
  manifestPath: string;
  repository: string;
  sourceFingerprint: string;
  sourcePath: string;
  taskId: string;
};

function normalizeSourceFingerprint(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function resolveCanonicalIssueSourcePath(sourcePath?: string): string {
  const explicitPath = String(sourcePath || "").trim();
  if (explicitPath) {
    return path.resolve(explicitPath);
  }

  const taskIssueSourcePath = String(Bun.env.OMTA_TASK_ISSUE_SOURCE || "").trim();
  if (taskIssueSourcePath) {
    return path.resolve(taskIssueSourcePath);
  }

  const canonicalEnvPath = String(Bun.env.ISSUE_GRAPH_SOURCE || "").trim();
  if (canonicalEnvPath) {
    return path.resolve(canonicalEnvPath);
  }

  fail(
    "task-scope requires canonical issue snapshot source via --source, OMTA_TASK_ISSUE_SOURCE, or ISSUE_GRAPH_SOURCE; worker-facing live GitHub task enumeration is retired"
  );
}

export function resolveImmutableTaskIssueSourcePath(
  repoRoot: string,
  branch: string,
  sourceFingerprint: string
): string {
  const normalizedBranch = String(branch || "").trim();
  const normalizedFingerprint = normalizeSourceFingerprint(sourceFingerprint);
  if (!normalizedBranch) {
    fail("immutable task issue source resolution requires a branch");
  }
  if (!normalizedFingerprint) {
    fail("immutable task issue source resolution requires a source fingerprint");
  }
  return path.resolve(
    repoRoot,
    resolveGitPath(
      repoRoot,
      path.posix.join(
        "omta",
        "task-issue-sources",
        normalizedBranch,
        `${normalizedFingerprint}.json`
      )
    )
  );
}

export function resolveImmutableTaskScopeManifestPath(options: {
  branch: string;
  repoRoot: string;
  sourceFingerprint: string;
  taskId: string;
}): string {
  const normalizedBranch = String(options.branch || "").trim();
  const normalizedTaskId = normalizeTaskId(options.taskId);
  const normalizedFingerprint = normalizeSourceFingerprint(options.sourceFingerprint);
  if (!normalizedBranch) {
    fail("immutable task-scope manifest resolution requires a branch");
  }
  if (!normalizedTaskId) {
    fail("immutable task-scope manifest resolution requires a task id");
  }
  if (!normalizedFingerprint) {
    fail("immutable task-scope manifest resolution requires a source fingerprint");
  }
  return path.resolve(
    options.repoRoot,
    resolveGitPath(
      options.repoRoot,
      path.posix.join(
        "omta",
        "task-scope-manifests",
        normalizedBranch,
        `${normalizedTaskId}.${normalizedFingerprint}.json`
      )
    )
  );
}

function toCanonicalTaskIssueSnapshot(rawEntry: GraphIssueNode): CanonicalTaskIssueSnapshot | null {
  const entry = normalizeSourceIssue(rawEntry);
  const labels = extractLabels(entry.labels);
  if (!labels.includes("task") || entry.pull_request) {
    return null;
  }

  const metadata = parseTaskMetadata({
    issueNumber: entry.number,
    labels,
    source: entry,
    state: parseIssueState(entry.state),
    title: entry.title,
  });
  const taskId =
    normalizeTaskId(metadata.task_id) ||
    normalizeTaskId(extractTaskIdFromIssueBody(String(entry.body || ""))) ||
    extractTaskIdFromTitle(entry.title);

  return {
    body: String(entry.body || ""),
    issueNumber: Number(entry.number || 0),
    issueUrl: String(entry.html_url || entry.url || ""),
    labels,
    metadata: {
      ...metadata,
      task_id: taskId,
    },
    state: parseIssueState(entry.state) === "closed" ? "CLOSED" : "OPEN",
    title: String(entry.title || "").trim(),
  };
}

function resolveTaskIdFromSnapshot(snapshot: CanonicalTaskIssueSnapshot): string {
  return (
    normalizeTaskId(snapshot.metadata.task_id) ||
    normalizeTaskId(extractTaskIdFromIssueBody(snapshot.body)) ||
    extractTaskIdFromTitle(snapshot.title)
  );
}

export function readCanonicalTaskIssueSnapshotsFromSource(
  sourcePath?: string
): CanonicalTaskIssueSnapshot[] {
  const absolute = resolveCanonicalIssueSourcePath(sourcePath);
  const parsed = parseJson(readFileSync(absolute, "utf8"), absolute);
  let snapshots: unknown[] | null = null;
  if (Array.isArray(parsed)) {
    snapshots = parsed;
  } else if (
    parsed &&
    typeof parsed === "object" &&
    Array.isArray((parsed as { issues?: unknown }).issues)
  ) {
    snapshots = (parsed as { issues: unknown[] }).issues;
  }
  if (!snapshots) {
    fail(`task-scope source must be a JSON array or object-wrapped issues array: ${absolute}`);
  }

  return snapshots
    .filter(
      (entry): entry is GraphIssueNode =>
        Boolean(entry) && typeof entry === "object" && !Array.isArray(entry)
    )
    .map((entry) => toCanonicalTaskIssueSnapshot(entry))
    .filter((entry): entry is CanonicalTaskIssueSnapshot => Boolean(entry))
    .filter((entry) => entry.issueNumber > 0);
}

function resolveIssueSnapshot(options: {
  repository: string;
  sourcePath?: string;
  taskId: string;
}): CanonicalTaskIssueSnapshot {
  const taskId = normalizeTaskId(options.taskId);
  const snapshots = readCanonicalTaskIssueSnapshotsFromSource(options.sourcePath);

  const matches = snapshots.filter((snapshot) => resolveTaskIdFromSnapshot(snapshot) === taskId);
  if (matches.length === 0) {
    fail(`task-scope could not find a canonical task issue snapshot for ${taskId}`);
  }
  if (matches.length > 1) {
    fail(
      `task-scope found multiple canonical task issue snapshots for ${taskId}: ${matches.map((snapshot) => `#${snapshot.issueNumber}`).join(", ")}`
    );
  }
  return matches[0] as CanonicalTaskIssueSnapshot;
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function buildTaskScopeManifest(options: {
  acceptanceChecks: string[];
  admissionMode?: TaskScopeAdmissionMode;
  allowedFiles: string[];
  deps?: string[];
  globalInvariant?: string;
  issueNumber: number;
  issueUrl: string;
  taskId: string;
  tests: string[];
  title: string;
  unfreezeCondition?: string;
  commitUnits?: string[];
}): TaskScopeManifest {
  const derived = deriveTaskScopeAdmissionClassification({
    allowedFiles: options.allowedFiles,
    commitUnits: options.commitUnits || [],
  });
  const now = new Date().toISOString();
  const admissionMode = normalizeAdmissionMode(options.admissionMode);
  const globalInvariant =
    admissionMode === "global-exclusive" ? String(options.globalInvariant || "").trim() : "";
  const unfreezeCondition =
    admissionMode === "global-exclusive" ? String(options.unfreezeCondition || "").trim() : "";

  return {
    version: TASK_SCOPE_VERSION,
    taskId: normalizeTaskId(options.taskId),
    issueNumber: options.issueNumber,
    issueUrl: options.issueUrl,
    title: options.title,
    ownerBucket: derived.ownerBucket,
    ownerBuckets: derived.ownerBuckets,
    allowedGlobs: derived.allowedGlobs,
    commitUnits: [
      ...new Set(
        (options.commitUnits || []).map((value) => String(value || "").trim()).filter(Boolean)
      ),
    ],
    admissionMode,
    globalInvariant,
    unfreezeCondition,
    scopeGateKeys: derived.scopeGateKeys,
    serializedScopeKeys: derived.serializedScopeKeys,
    hotRootPaths: derived.hotRootPaths,
    touchesHotRoot: derived.touchesHotRoot,
    conflictClass: derived.conflictClass,
    verificationClass: derived.verificationClass,
    resourceClaims: derived.resourceClaims,
    dependencyEdges: [
      ...new Set((options.deps || []).map((dep) => normalizeTaskId(dep)).filter(Boolean)),
    ],
    acceptanceChecks: [
      ...new Set(
        options.acceptanceChecks.map((value) => String(value || "").trim()).filter(Boolean)
      ),
    ],
    tests: [...new Set(options.tests.map((value) => String(value || "").trim()).filter(Boolean))],
    createdAt: now,
    updatedAt: now,
  };
}

export function buildTaskScopeManifestFromTaskIssue(issue: TaskIssue): TaskScopeManifest {
  return buildTaskScopeManifest({
    acceptanceChecks: issue.metadata.acceptance_checks,
    admissionMode: issue.metadata.admission_mode,
    allowedFiles: issue.metadata.allowed_files,
    // issue.metadata.deps is derived from canonical native blockedBy links during issue-graph load.
    deps: issue.metadata.deps,
    globalInvariant: issue.metadata.global_invariant,
    issueNumber: issue.number,
    issueUrl: String(issue.htmlUrl || "").trim(),
    taskId: issue.metadata.task_id,
    commitUnits: issue.metadata.commit_units,
    tests: issue.metadata.tests,
    title: String(issue.title || "").trim(),
    unfreezeCondition: issue.metadata.unfreeze_condition,
  });
}

function normalizeManifest(raw: unknown): TaskScopeManifest | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  if (Number(item.version || 0) !== TASK_SCOPE_VERSION) return null;
  const taskId = normalizeTaskId(String(item.taskId || "").trim());
  if (!taskId) return null;
  const ownerBucket = String(item.ownerBucket || "").trim();
  const ownerBuckets = normalizeStringArray(item.ownerBuckets, (value) => value.trim());
  const allowedGlobs = normalizeStringArray(item.allowedGlobs, (value) =>
    normalizePathPattern(value)
  );
  const commitUnits = normalizeStringArray(item.commitUnits, (value) => value.trim());
  const admissionMode = normalizeAdmissionMode(item.admissionMode);
  const globalInvariant = String(item.globalInvariant || "").trim();
  const unfreezeCondition = String(item.unfreezeCondition || "").trim();
  const scopeGateKeys = normalizeStringArray(item.scopeGateKeys, (value) => value.trim());
  const serializedScopeKeys = normalizeStringArray(item.serializedScopeKeys, (value) =>
    value.trim()
  );
  const hotRootPaths = normalizeStringArray(item.hotRootPaths, (value) =>
    normalizePathPattern(value)
  );
  const conflictClass = String(item.conflictClass || "").trim();
  const verificationClass = String(item.verificationClass || "").trim();
  const resourceClaims =
    item.resourceClaims === undefined
      ? null
      : normalizeTaskScopeResourceClaims(item.resourceClaims);
  const dependencyEdges = normalizeStringArray(item.dependencyEdges, (value) =>
    normalizeTaskId(value)
  );
  const acceptanceChecks = normalizeStringArray(item.acceptanceChecks, (value) => value.trim());
  const tests = normalizeStringArray(item.tests, (value) => value.trim());
  const issueNumber = Number(item.issueNumber || 0);
  const issueUrl = String(item.issueUrl || "").trim();
  const title = String(item.title || "").trim();
  const createdAt = String(item.createdAt || "").trim();
  const updatedAt = String(item.updatedAt || "").trim();
  if (!ownerBucket) return null;
  if (!allowedGlobs || allowedGlobs.length === 0) return null;
  if (!commitUnits || commitUnits.length === 0) return null;
  if (!isTaskScopeConflictClass(conflictClass)) return null;
  if (!isTaskScopeVerificationClass(verificationClass)) return null;
  if (!isTaskScopeAdmissionMode(admissionMode)) return null;
  if (
    !ownerBuckets ||
    ownerBuckets.length === 0 ||
    !scopeGateKeys ||
    !serializedScopeKeys ||
    !hotRootPaths
  )
    return null;
  if (!dependencyEdges || !acceptanceChecks || !tests) return null;
  if (!Number.isInteger(issueNumber) || issueNumber <= 0 || !issueUrl || !title) return null;
  if (!createdAt || !updatedAt) return null;
  if (admissionMode === "global-exclusive" && (!globalInvariant || !unfreezeCondition)) {
    return null;
  }
  if (
    (admissionMode === "standard" || admissionMode === "landing-exclusive") &&
    (globalInvariant || unfreezeCondition)
  ) {
    return null;
  }
  const touchesHotRoot = Boolean(item.touchesHotRoot);
  const derived = deriveTaskScopeAdmissionClassification({
    allowedFiles: allowedGlobs,
    commitUnits,
  });
  if (touchesHotRoot !== derived.touchesHotRoot) return null;
  if (ownerBucket !== derived.ownerBucket) return null;
  if (!arraysEqual(ownerBuckets, derived.ownerBuckets)) return null;
  if (!arraysEqual(commitUnits, [...new Set(commitUnits)])) return null;
  if (!arraysEqual(scopeGateKeys, derived.scopeGateKeys)) return null;
  if (!arraysEqual(serializedScopeKeys, derived.serializedScopeKeys)) return null;
  if (!arraysEqual(hotRootPaths, derived.hotRootPaths)) return null;
  if (conflictClass !== derived.conflictClass) return null;
  if (verificationClass !== derived.verificationClass) return null;
  if (resourceClaims && !resourceClaimsEqual(resourceClaims, derived.resourceClaims)) return null;
  return {
    version: TASK_SCOPE_VERSION,
    taskId,
    issueNumber,
    issueUrl,
    title,
    ownerBucket: derived.ownerBucket,
    ownerBuckets: derived.ownerBuckets,
    allowedGlobs: derived.allowedGlobs,
    commitUnits: [...new Set(commitUnits)],
    admissionMode,
    globalInvariant,
    unfreezeCondition,
    scopeGateKeys: derived.scopeGateKeys,
    serializedScopeKeys: derived.serializedScopeKeys,
    hotRootPaths: derived.hotRootPaths,
    touchesHotRoot: derived.touchesHotRoot,
    conflictClass: derived.conflictClass,
    verificationClass: derived.verificationClass,
    resourceClaims: derived.resourceClaims,
    dependencyEdges,
    acceptanceChecks,
    tests,
    createdAt,
    updatedAt,
  };
}

export function resolveTaskScopeManifestPath(repoRoot: string, taskId: string): string {
  return path.join(resolveTaskScopeRootFromRepoRoot(repoRoot), `${normalizeTaskId(taskId)}.json`);
}

export function resolveMaterializedTaskIssueSourcePath(repoRoot: string, branch: string): string {
  const normalizedBranch = String(branch || "").trim();
  if (!normalizedBranch) {
    fail("materialized task issue source resolution requires a branch");
  }
  return path.resolve(
    repoRoot,
    runGit(repoRoot, [
      "rev-parse",
      "--git-path",
      path.posix.join("omta", "task-issue-sources", `${normalizedBranch}.json`),
    ])
  );
}

export function writeMaterializedTaskIssueSource(options: {
  branch: string;
  repoRoot: string;
  snapshots: GraphIssueNode[];
}): string {
  const sourcePath = resolveMaterializedTaskIssueSourcePath(options.repoRoot, options.branch);
  mkdirSync(path.dirname(sourcePath), { recursive: true });
  writeFileSync(sourcePath, `${JSON.stringify(options.snapshots, null, 2)}\n`, "utf8");
  return sourcePath;
}

export function writeImmutableTaskIssueSource(options: {
  branch: string;
  repoRoot: string;
  snapshots: GraphIssueNode[];
  sourceFingerprint: string;
}): string {
  const sourcePath = resolveImmutableTaskIssueSourcePath(
    options.repoRoot,
    options.branch,
    options.sourceFingerprint
  );
  mkdirSync(path.dirname(sourcePath), { recursive: true });
  writeFileSync(sourcePath, `${JSON.stringify(options.snapshots, null, 2)}\n`, "utf8");
  return sourcePath;
}

function readIssueSourceSnapshotsFromPath(filePath: string): GraphIssueNode[] {
  const parsed = parseJson(readFileSync(filePath, "utf8"), filePath);
  if (Array.isArray(parsed)) {
    return parsed.filter(
      (entry): entry is GraphIssueNode =>
        Boolean(entry) && typeof entry === "object" && !Array.isArray(entry)
    );
  }
  if (parsed && typeof parsed === "object") {
    const wrappedIssues = (parsed as { issues?: unknown }).issues;
    if (Array.isArray(wrappedIssues)) {
      return wrappedIssues.filter(
        (entry): entry is GraphIssueNode =>
          Boolean(entry) && typeof entry === "object" && !Array.isArray(entry)
      );
    }
  }
  fail(`task issue source must be a JSON array or object-wrapped issues array: ${filePath}`);
}

export function resolveCurrentTaskIssueSourcePath(options: {
  branch?: string;
  explicitSourcePath?: string;
  repoRoot: string;
}): string {
  const explicitPath = String(options.explicitSourcePath || "").trim();
  if (explicitPath) {
    return path.resolve(explicitPath);
  }

  const taskIssueSourcePath = String(Bun.env.OMTA_TASK_ISSUE_SOURCE || "").trim();
  if (taskIssueSourcePath) {
    return path.resolve(taskIssueSourcePath);
  }

  const branch = String(options.branch || "").trim();
  if (branch) {
    const taskId = normalizeTaskId(extractTaskIdFromBranch(branch) || "");
    const repository = taskId ? detectRepositoryFromOrigin(options.repoRoot) : "";
    const snapshot = readTaskIssueSnapshot(options.repoRoot, branch);
    if (
      taskId &&
      isTaskIssueSnapshotCurrent(snapshot, {
        repository,
        branch,
        taskId,
      })
    ) {
      const immutableSourcePath = resolveImmutableTaskIssueSourcePath(
        options.repoRoot,
        branch,
        snapshot.source_fingerprint
      );
      if (existsSync(immutableSourcePath)) {
        return immutableSourcePath;
      }
    }
    const materializedSourcePath = resolveMaterializedTaskIssueSourcePath(options.repoRoot, branch);
    if (existsSync(materializedSourcePath)) {
      return materializedSourcePath;
    }
  }

  const canonicalEnvPath = String(Bun.env.ISSUE_GRAPH_SOURCE || "").trim();
  if (canonicalEnvPath) {
    return path.resolve(canonicalEnvPath);
  }

  return "";
}

function resolveBranchLocalMaterializedTaskIssueSourcePath(
  repoRoot: string,
  branch: string
): string {
  const normalizedBranch = String(branch || "").trim();
  if (!normalizedBranch) {
    return "";
  }
  const materializedSourcePath = resolveMaterializedTaskIssueSourcePath(repoRoot, normalizedBranch);
  return existsSync(materializedSourcePath) ? materializedSourcePath : "";
}

export function readTaskScopeManifest(repoRoot: string, taskId: string): TaskScopeManifest | null {
  const manifestPath = resolveTaskScopeManifestPath(repoRoot, taskId);
  if (!existsSync(manifestPath)) return null;
  return normalizeManifest(parseJson(readFileSync(manifestPath, "utf8"), manifestPath));
}

export function writeTaskScopeManifest(options: {
  manifest: TaskScopeManifest;
  repoRoot: string;
}): string {
  const manifestPath = resolveTaskScopeManifestPath(options.repoRoot, options.manifest.taskId);
  mkdirSync(path.dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(options.manifest, null, 2)}\n`, "utf8");
  return manifestPath;
}

export function writeImmutableTaskScopeManifest(options: {
  branch: string;
  manifest: TaskScopeManifest;
  repoRoot: string;
  sourceFingerprint: string;
}): string {
  const manifestPath = resolveImmutableTaskScopeManifestPath({
    branch: options.branch,
    repoRoot: options.repoRoot,
    sourceFingerprint: options.sourceFingerprint,
    taskId: options.manifest.taskId,
  });
  mkdirSync(path.dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(options.manifest, null, 2)}\n`, "utf8");
  return manifestPath;
}

export function readImmutableTaskScopeManifest(options: {
  branch: string;
  repoRoot: string;
  sourceFingerprint: string;
  taskId: string;
}): TaskScopeManifest | null {
  const manifestPath = resolveImmutableTaskScopeManifestPath(options);
  if (!existsSync(manifestPath)) {
    return null;
  }
  return normalizeManifest(parseJson(readFileSync(manifestPath, "utf8"), manifestPath));
}

export function materializeTaskScopeManifestForTaskIssue(options: {
  issue: TaskIssue;
  repoRoot: string;
}): { manifest: TaskScopeManifest; manifestPath: string } {
  const manifest = buildTaskScopeManifestFromTaskIssue(options.issue);
  const manifestPath = writeTaskScopeManifest({
    repoRoot: options.repoRoot,
    manifest,
  });
  return { manifest, manifestPath };
}

function resolveTaskSourceFingerprintFromSource(options: {
  repository: string;
  sourcePath: string;
  taskId: string;
}): string {
  const issue = resolveIssueSnapshot(options);
  return buildTaskIssueSourceFingerprint({
    issueNumber: issue.issueNumber,
    title: issue.title,
    body: issue.body,
    issueUrl: issue.issueUrl,
    state: issue.state,
  });
}

export function ensureCurrentTaskSessionArtifacts(options: {
  branch?: string;
  repoRoot: string;
  repository?: string;
  sourcePath?: string;
  taskId?: string;
}): CurrentTaskSessionArtifacts | null {
  const branch = String(options.branch || "").trim();
  if (!branch) {
    return null;
  }
  const taskId =
    normalizeTaskId(options.taskId || "") || normalizeTaskId(extractTaskIdFromBranch(branch) || "");
  if (!taskId) {
    return null;
  }
  const repository = options.repository || detectRepositoryFromOrigin(options.repoRoot);

  const explicitSourcePath = String(options.sourcePath || "").trim();
  const branchLocalSourcePath =
    !explicitSourcePath && branch
      ? resolveBranchLocalMaterializedTaskIssueSourcePath(options.repoRoot, branch)
      : "";
  const snapshot = readTaskIssueSnapshot(options.repoRoot, branch);
  const snapshotFingerprint = normalizeSourceFingerprint(snapshot?.source_fingerprint || "");
  let currentSnapshotWithoutSource = null;
  if (
    !explicitSourcePath &&
    snapshot &&
    isTaskIssueSnapshotCurrent(snapshot, {
      repository,
      branch,
      taskId,
    })
  ) {
    currentSnapshotWithoutSource = snapshot;
  }
  const currentSnapshot = explicitSourcePath || !snapshot ? null : currentSnapshotWithoutSource;

  const sourceFingerprint = explicitSourcePath
    ? resolveTaskSourceFingerprintFromSource({
        repository,
        sourcePath: explicitSourcePath,
        taskId,
      })
    : normalizeSourceFingerprint(currentSnapshot?.source_fingerprint || "") ||
      (branchLocalSourcePath
        ? resolveTaskSourceFingerprintFromSource({
            repository,
            sourcePath: branchLocalSourcePath,
            taskId,
          })
        : "");
  if (!sourceFingerprint) {
    return null;
  }
  if (explicitSourcePath && snapshotFingerprint) {
    const snapshotIsCurrent = isTaskIssueSnapshotCurrent(snapshot, {
      repository,
      branch,
      taskId,
    });
    if (snapshotIsCurrent && snapshotFingerprint !== sourceFingerprint) {
      fail(
        [
          `publish admission for ${taskId} is using a stale task snapshot.`,
          `- current snapshot fingerprint: ${snapshotFingerprint}`,
          `- requested source fingerprint: ${sourceFingerprint}`,
          "- refresh the task snapshot through the control plane before publishing",
        ].join("\n")
      );
    }
  }

  const immutableSourcePath = resolveImmutableTaskIssueSourcePath(
    options.repoRoot,
    branch,
    sourceFingerprint
  );
  if (!existsSync(immutableSourcePath)) {
    const seedSourcePath =
      explicitSourcePath ||
      branchLocalSourcePath ||
      resolveCurrentTaskIssueSourcePath({
        branch,
        repoRoot: options.repoRoot,
      });
    if (!seedSourcePath) {
      return null;
    }
    writeImmutableTaskIssueSource({
      branch,
      repoRoot: options.repoRoot,
      snapshots: readIssueSourceSnapshotsFromPath(seedSourcePath),
      sourceFingerprint,
    });
  }

  const manifestPath = resolveImmutableTaskScopeManifestPath({
    branch,
    repoRoot: options.repoRoot,
    sourceFingerprint,
    taskId,
  });
  let manifest = readImmutableTaskScopeManifest({
    branch,
    repoRoot: options.repoRoot,
    sourceFingerprint,
    taskId,
  });
  if (!manifest) {
    manifest = resolveTaskScopeManifest({
      repository,
      sourcePath: immutableSourcePath,
      taskId,
    });
    writeImmutableTaskScopeManifest({
      branch,
      manifest,
      repoRoot: options.repoRoot,
      sourceFingerprint,
    });
  }

  return {
    branch,
    manifest,
    manifestPath,
    repository,
    sourceFingerprint,
    sourcePath: immutableSourcePath,
    taskId,
  };
}

export function resolveTaskScopeManifest(options: {
  repository: string;
  sourcePath?: string;
  taskId: string;
}): TaskScopeManifest {
  const issue = resolveIssueSnapshot(options);
  const rebuilt = tryBuildTaskScopeSnapshotFromIssueSnapshot({
    title: issue.title,
    body: issue.body,
    metadata: issue.metadata,
  });
  if (!rebuilt.scope) {
    fail(
      `task-scope could not rebuild canonical task spec for ${options.taskId}: ${rebuilt.errors.join("; ")}`
    );
  }
  return buildTaskScopeManifest({
    acceptanceChecks: rebuilt.scope.acceptance_checks,
    admissionMode: rebuilt.scope.admission_mode,
    allowedFiles: rebuilt.scope.allowed_files,
    deps: rebuilt.scope.deps,
    globalInvariant: rebuilt.scope.global_invariant,
    issueNumber: issue.issueNumber,
    issueUrl: issue.issueUrl,
    taskId: rebuilt.scope.task_id,
    commitUnits: rebuilt.scope.commit_units,
    tests: rebuilt.scope.tests,
    title: issue.title,
    unfreezeCondition: rebuilt.scope.unfreeze_condition,
  });
}

export function ensureTaskScopeManifest(options: {
  repoRoot: string;
  repository?: string;
  sourcePath?: string;
  taskId: string;
}): TaskScopeManifest {
  const existing = readTaskScopeManifest(options.repoRoot, options.taskId);
  if (existing) return existing;
  const manifest = resolveTaskScopeManifest({
    repository: options.repository || detectRepositoryFromOrigin(options.repoRoot),
    sourcePath: options.sourcePath,
    taskId: options.taskId,
  });
  writeTaskScopeManifest({ repoRoot: options.repoRoot, manifest });
  return manifest;
}

function resolveCheckedOutTaskScopeManifest(options: {
  branch: string;
  fallbackSourcePath?: string;
  repository?: string;
  taskId: string;
  worktreeRepoRoot: string;
}): TaskScopeManifest {
  const repository = options.repository || detectRepositoryFromOrigin(options.worktreeRepoRoot);
  const sessionArtifacts = ensureCurrentTaskSessionArtifacts({
    branch: options.branch,
    repoRoot: options.worktreeRepoRoot,
    repository,
    taskId: options.taskId,
  });
  if (sessionArtifacts?.manifest) {
    return sessionArtifacts.manifest;
  }

  let fallbackFailure: Error | null = null;
  if (options.fallbackSourcePath) {
    try {
      const repairedSessionArtifacts = ensureCurrentTaskSessionArtifacts({
        branch: options.branch,
        repoRoot: options.worktreeRepoRoot,
        repository,
        sourcePath: path.resolve(options.fallbackSourcePath),
        taskId: options.taskId,
      });
      if (repairedSessionArtifacts?.manifest) {
        return repairedSessionArtifacts.manifest;
      }
      fallbackFailure = new Error(
        `bounded canonical issue source did not materialize sibling session artifacts for ${options.taskId}`
      );
    } catch (error) {
      fallbackFailure =
        error instanceof Error ? error : new Error(String(error || "unknown error"));
    }
  }

  const branchLocalSourcePath = resolveBranchLocalMaterializedTaskIssueSourcePath(
    options.worktreeRepoRoot,
    options.branch
  );
  if (branchLocalSourcePath) {
    try {
      const repairedSessionArtifacts = ensureCurrentTaskSessionArtifacts({
        branch: options.branch,
        repoRoot: options.worktreeRepoRoot,
        repository,
        sourcePath: branchLocalSourcePath,
        taskId: options.taskId,
      });
      if (repairedSessionArtifacts?.manifest) {
        return repairedSessionArtifacts.manifest;
      }
      fallbackFailure = new Error(
        `branch-local sibling issue source did not materialize session artifacts for ${options.taskId}`
      );
    } catch (error) {
      fallbackFailure =
        error instanceof Error ? error : new Error(String(error || "unknown error"));
    }
  }

  fail(
    [
      renderStopReasonDiagnostic(
        "blocked_authority_unavailable_after_repair",
        `task-scope could not resolve canonical live authority for checked-out sibling task ${options.taskId}.`
      ),
      `- sibling branch: ${options.branch}`,
      "- refresh the sibling task snapshot through bun run task:ensure or pass a bounded canonical issue source",
      "- repo-wide task issue catalog snapshots are projection-only and are not sibling admission authority",
      ...(fallbackFailure
        ? [`- explicit canonical issue source failed: ${fallbackFailure.message}`]
        : []),
    ].join("\n")
  );
}

export function ensureMaterializedTaskScopeManifest(options: {
  repoRoot: string;
  repository?: string;
  sourcePath?: string;
  taskId: string;
}): { manifest: TaskScopeManifest; manifestPath: string } {
  const existing = readTaskScopeManifest(options.repoRoot, options.taskId);
  if (existing) {
    return {
      manifest: existing,
      manifestPath: resolveTaskScopeManifestPath(options.repoRoot, options.taskId),
    };
  }
  const manifest = resolveTaskScopeManifest({
    repository: options.repository || detectRepositoryFromOrigin(options.repoRoot),
    sourcePath: options.sourcePath,
    taskId: options.taskId,
  });
  const manifestPath = writeTaskScopeManifest({ repoRoot: options.repoRoot, manifest });
  return { manifest, manifestPath };
}

export function pathMatchesTaskScope(filePath: string, allowedGlobs: string[]): boolean {
  const normalizedPath = normalizePathPattern(filePath).replace(/\\/g, "/");
  return allowedGlobs.some((pattern) => {
    const normalizedPattern = normalizePathPattern(pattern).replace(/\\/g, "/");
    if (!normalizedPattern) return false;
    return path.posix.matchesGlob(normalizedPath, normalizedPattern);
  });
}

export function findTaskScopeEscapes(filePaths: string[], manifest: TaskScopeManifest): string[] {
  return [
    ...new Set(
      filePaths
        .map((filePath) => normalizePathPattern(filePath))
        .filter(Boolean)
        .filter((filePath) => !pathMatchesTaskScope(filePath, manifest.allowedGlobs))
    ),
  ].sort((left, right) => left.localeCompare(right));
}

function detectManifestConflict(
  candidate: TaskScopeManifest,
  other: TaskScopeManifest
): TaskScopeConflict | null {
  const conflict =
    candidate.taskId === other.taskId
      ? detectTaskScopeAdmissionConflict(
          {
            taskId: candidate.taskId,
            allowedGlobs: candidate.allowedGlobs,
            commitUnits: candidate.commitUnits,
            admissionMode: candidate.admissionMode,
            globalInvariant: candidate.globalInvariant,
            unfreezeCondition: candidate.unfreezeCondition,
          },
          {
            taskId: other.taskId,
            allowedGlobs: other.allowedGlobs,
            commitUnits: other.commitUnits,
            admissionMode: other.admissionMode,
            globalInvariant: other.globalInvariant,
            unfreezeCondition: other.unfreezeCondition,
          }
        ) || {
          candidatePath:
            candidate.serializedScopeKeys[0] || candidate.allowedGlobs[0] || candidate.taskId,
          otherPath: other.serializedScopeKeys[0] || other.allowedGlobs[0] || other.taskId,
          reason: "serialized_scope_overlap" as const,
          serializedScopeKey:
            candidate.serializedScopeKeys[0] || other.serializedScopeKeys[0] || candidate.taskId,
        }
      : detectTaskScopeAdmissionConflict(
          {
            taskId: candidate.taskId,
            allowedGlobs: candidate.allowedGlobs,
            commitUnits: candidate.commitUnits,
            admissionMode: candidate.admissionMode,
            globalInvariant: candidate.globalInvariant,
            unfreezeCondition: candidate.unfreezeCondition,
          },
          {
            taskId: other.taskId,
            allowedGlobs: other.allowedGlobs,
            commitUnits: other.commitUnits,
            admissionMode: other.admissionMode,
            globalInvariant: other.globalInvariant,
            unfreezeCondition: other.unfreezeCondition,
          }
        );
  if (!conflict) return null;
  return {
    ...conflict,
    candidateTaskId: candidate.taskId,
    otherTaskId: other.taskId,
  };
}

export function renderTaskScopeConflictSummary(conflict: TaskScopeConflict): string {
  if (conflict.reason === "global_exclusive_lock") {
    return `global-exclusive admission is held by ${conflict.otherTaskId}: ${conflict.otherPath}`;
  }
  if (conflict.reason === "serialized_scope_overlap") {
    return `serialized scope conflicts with ${conflict.otherTaskId}: ${conflict.serializedScopeKey || conflict.candidatePath}`;
  }
  if (conflict.reason === "resource_claim_overlap") {
    const resource = conflict.resource || conflict.candidatePath;
    const modeSummary =
      conflict.candidateClaimMode && conflict.otherClaimMode
        ? ` (${conflict.candidateClaimMode} <-> ${conflict.otherClaimMode})`
        : "";
    return `shared-resource claim conflicts with ${conflict.otherTaskId}: ${resource}${modeSummary}`;
  }
  if (conflict.reason === "hot_root_lock") {
    return `hot-root lock conflicts with ${conflict.otherTaskId}: ${conflict.candidatePath} <-> ${conflict.otherPath}`;
  }
  return `commit-unit conflict with ${conflict.otherTaskId}: ${conflict.commitUnit || conflict.candidatePath}`;
}

export function classifyTaskScopeConflictStopReason(
  conflict: TaskScopeConflict
): TaskScopeStopReason {
  if (conflict.reason === "global_exclusive_lock") {
    return "blocked_real_global_exclusive_conflict";
  }
  if (conflict.reason === "resource_claim_overlap") {
    return "blocked_real_resource_conflict";
  }
  return "blocked_real_scope_conflict";
}

export function renderTaskScopeConflictDiagnostic(conflict: TaskScopeConflict): string {
  return renderStopReasonDiagnostic(
    classifyTaskScopeConflictStopReason(conflict),
    renderTaskScopeConflictSummary(conflict)
  );
}

export function collectManifestConflicts(
  candidate: TaskScopeManifest,
  others: TaskScopeManifest[]
): TaskScopeConflict[] {
  return others
    .map((other) => detectManifestConflict(candidate, other))
    .filter((conflict): conflict is TaskScopeConflict => conflict !== null);
}

export function assertTaskScopeFiles(options: {
  changedFiles: string[];
  manifest: TaskScopeManifest;
}): void {
  const escapes = findTaskScopeEscapes(options.changedFiles, options.manifest);
  if (escapes.length === 0) return;
  fail(
    [
      `task-scope violation for ${options.manifest.taskId}: changed files escaped Allowed Files.`,
      ...escapes.map((filePath) => `  - ${filePath}`),
    ].join("\n")
  );
}

function runGit(repoRoot: string, args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", repoRoot, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    // biome-ignore lint/style/noProcessEnv: task-scope git subprocesses must inherit the live repo execution environment.
    env: process.env,
  });
  if (result.exitCode !== 0) {
    const detail =
      `${new TextDecoder().decode(result.stderr)}\n${new TextDecoder().decode(result.stdout)}`.trim();
    fail(`git ${args.join(" ")} failed: ${detail || `exit=${result.exitCode}`}`);
  }
  return new TextDecoder().decode(result.stdout).trim();
}

function readGitLines(repoRoot: string, args: string[]): string[] {
  return runGit(repoRoot, args)
    .split(/\r?\n/u)
    .map((line) => normalizePathPattern(line))
    .filter(Boolean);
}

export function readStagedChangedFiles(repoRoot: string): string[] {
  return readGitLines(repoRoot, ["diff", "--cached", "--name-only"]);
}

export function readChangedFilesForRange(repoRoot: string, range: string): string[] {
  return readGitLines(repoRoot, ["diff", "--name-only", range]);
}

type CanonicalTaskWorktree = ReturnType<typeof listCanonicalTaskWorktrees>[number];
type ActiveCanonicalWorktree = {
  activity: ReturnType<typeof inspectCanonicalWorktreeActivity>;
  worktree: CanonicalTaskWorktree;
};

export function assertNoTaskWorktreeConflicts(options: {
  admissionLabel?: string;
  manifest: TaskScopeManifest;
  repoRoot: string;
  repository?: string;
  sourcePath?: string;
}): void {
  const otherManifests = listCanonicalTaskWorktrees(options.repoRoot)
    .map((worktree) => {
      try {
        return {
          activity: inspectCanonicalWorktreeActivity(worktree.path),
          worktree,
        };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is ActiveCanonicalWorktree => entry !== null)
    .filter(({ activity }) => activity.state === "active writer")
    .map(({ worktree }) => worktree)
    .map((worktree) => {
      const taskId = extractTaskIdFromBranch(worktree.branch);
      if (!taskId) {
        return null;
      }
      return resolveCheckedOutTaskScopeManifest({
        branch: worktree.branch,
        fallbackSourcePath: options.sourcePath,
        repository: options.repository,
        taskId,
        worktreeRepoRoot: worktree.path,
      });
    })
    .filter(
      (manifest): manifest is TaskScopeManifest =>
        manifest !== null && manifest.taskId !== options.manifest.taskId
    );
  const conflicts = collectManifestConflicts(options.manifest, otherManifests);
  if (conflicts.length === 0) return;
  fail(
    [
      `task-scope admission denied for ${options.manifest.taskId} during ${options.admissionLabel || "worktree start"}.`,
      ...conflicts.map((conflict) => `  - ${renderTaskScopeConflictDiagnostic(conflict)}`),
    ].join("\n")
  );
}
