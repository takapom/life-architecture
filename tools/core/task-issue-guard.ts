import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { TASK_ID_PATTERN, type TaskIssue } from "./issue-graph-types";
import {
  normalizeIssueBodyForComparison,
  renderIssueBody,
  tryBuildTaskSpecFromIssueSnapshot,
} from "./task-issue-contract";

export type VerifiedTaskIssueMarker = {
  version: 1;
  repository: string;
  branch: string;
  task_id: string;
  issue_number: number;
  issue_url: string;
  parent_issue_number?: number;
  parent_issue_url?: string;
  verified_at: string;
};

export type TaskIssueSnapshot = {
  version: 1;
  repository: string;
  branch: string;
  task_id: string;
  issue_number: number;
  issue_url: string;
  parent_issue_number?: number;
  parent_issue_url?: string;
  source_fingerprint: string;
  verified_at: string;
};

export type TaskIssueSourceOfTruthAudit = {
  issue_number: number;
  task_id: string;
  errors: string[];
  mismatches: string[];
  normalized_title: string;
  normalized_body: string;
  can_apply: boolean;
};

const TASK_BRANCH_PREFIX = "task/";
const DEPRECATED_PROJECT_OWNED_SECTIONS = new Set(["task id", "task type", "status", "priority"]);
const GITHUB_SSH_RE = /^git@github\.com:(?<owner>[^/\s]+)\/(?<repo>[^/\s]+?)(?:\.git)?$/;
const GITHUB_HTTPS_RE =
  /^https:\/\/github\.com\/(?<owner>[^/\s]+)\/(?<repo>[^/\s]+?)(?:\.git)?\/?$/;
const GITHUB_SSH_URL_RE =
  /^ssh:\/\/git@github\.com\/(?<owner>[^/\s]+)\/(?<repo>[^/\s]+?)(?:\.git)?\/?$/;
const TASK_ID_NORMALIZATION_RE =
  /^(?<stem>[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z][A-Za-z0-9]*)*-\d{3,})(?<suffix>[A-Za-z]?)$/u;

function runGit(repoRoot: string, args: string[]): string {
  const result = spawnSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const detail = `${result.stderr || ""}\n${result.stdout || ""}`.trim();
    throw new Error(`git ${args.join(" ")} failed: ${detail || `exit=${result.status}`}`);
  }
  return String(result.stdout || "").trim();
}

export function normalizeTaskId(value: string): string {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return "";
  }

  const matched = trimmed.match(TASK_ID_NORMALIZATION_RE);
  if (!matched?.groups?.stem) {
    return trimmed.toUpperCase();
  }

  // Canonical normalization uppercases the task-id stem while preserving any
  // explicit suffix spelling so invalid uppercase suffixes still fail closed.
  return `${matched.groups.stem.toUpperCase()}${matched.groups.suffix || ""}`;
}

export function isTaskBranch(branch: string): boolean {
  return String(branch || "").startsWith(TASK_BRANCH_PREFIX);
}

export function extractTaskIdFromBranch(branch: string): string | null {
  const normalizedBranch = String(branch || "").trim();
  if (!isTaskBranch(normalizedBranch)) {
    return null;
  }

  const suffix = normalizedBranch.slice(TASK_BRANCH_PREFIX.length);
  const parts = suffix
    .split("-")
    .map((part) => part.trim())
    .filter(Boolean);
  let matchedTaskId: string | null = null;

  for (let index = 2; index <= parts.length; index += 1) {
    const candidate = normalizeTaskId(parts.slice(0, index).join("-"));
    if (!TASK_ID_PATTERN.test(candidate)) {
      continue;
    }
    matchedTaskId = candidate;
  }

  return matchedTaskId;
}

export function resolveVerifiedTaskIssue(issues: TaskIssue[], taskId: string): TaskIssue {
  const normalizedTaskId = normalizeTaskId(taskId);
  if (!TASK_ID_PATTERN.test(normalizedTaskId)) {
    throw new Error(`task_id is invalid: ${taskId}`);
  }

  const matched = issues.filter(
    (issue) =>
      issue.state === "open" && normalizeTaskId(issue.metadata.task_id) === normalizedTaskId
  );

  if (matched.length === 0) {
    throw new Error(
      `no open GitHub task issue found for ${normalizedTaskId}. Create or normalize the canonical task issue before implementation.`
    );
  }

  if (matched.length > 1) {
    throw new Error(
      `multiple open GitHub task issues found for ${normalizedTaskId}: ${matched.map((issue) => `#${issue.number}`).join(", ")}`
    );
  }

  return matched[0];
}

export function parseGitHubRepositoryFromOriginUrl(originUrl: string): string {
  const normalized = String(originUrl || "").trim();
  if (!normalized) {
    throw new Error("git remote origin url is empty");
  }

  for (const pattern of [GITHUB_SSH_RE, GITHUB_HTTPS_RE, GITHUB_SSH_URL_RE]) {
    const matched = normalized.match(pattern);
    if (!matched?.groups?.owner || !matched.groups.repo) {
      continue;
    }
    return `${matched.groups.owner}/${matched.groups.repo}`;
  }

  throw new Error(`failed to resolve owner/repo from git remote origin: ${normalized}`);
}

export function detectRepositoryFromOrigin(repoRoot: string): string {
  const originUrl = runGit(repoRoot, ["config", "--get", "remote.origin.url"]);
  return parseGitHubRepositoryFromOriginUrl(originUrl);
}

export function currentGitBranch(repoRoot: string): string {
  return runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

export function taskIssueMarkerRelativePath(branch: string): string {
  return path.posix.join("omta", "task-issue-guards", `${branch}.json`);
}

export function taskIssueSnapshotRelativePath(branch: string): string {
  return path.posix.join("omta", "task-issue-snapshots", `${branch}.json`);
}

export function resolveGitPath(repoRoot: string, relativePath: string): string {
  const resolvedPath = runGit(repoRoot, ["rev-parse", "--git-path", relativePath]);
  return path.isAbsolute(resolvedPath) ? resolvedPath : path.resolve(repoRoot, resolvedPath);
}

export function readVerifiedTaskIssueMarker(
  repoRoot: string,
  branch: string
): VerifiedTaskIssueMarker | null {
  const markerPath = path.resolve(
    repoRoot,
    resolveGitPath(repoRoot, taskIssueMarkerRelativePath(branch))
  );
  if (!existsSync(markerPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(markerPath, "utf8")) as Partial<VerifiedTaskIssueMarker>;
    if (
      parsed?.version !== 1 ||
      typeof parsed.branch !== "string" ||
      typeof parsed.task_id !== "string" ||
      typeof parsed.repository !== "string"
    ) {
      return null;
    }
    return parsed as VerifiedTaskIssueMarker;
  } catch {
    return null;
  }
}

export function isVerifiedTaskIssueMarkerCurrent(
  marker: VerifiedTaskIssueMarker | null,
  options: { repository: string; branch: string; taskId: string }
): boolean {
  if (!marker) {
    return false;
  }

  const hasParentIssueNumber =
    Number.isInteger(marker.parent_issue_number) && Number(marker.parent_issue_number) > 0;
  const hasParentIssueUrl = Boolean(String(marker.parent_issue_url || "").trim());

  return (
    marker.version === 1 &&
    marker.repository === options.repository &&
    marker.branch === options.branch &&
    marker.task_id === normalizeTaskId(options.taskId) &&
    Number.isInteger(marker.issue_number) &&
    marker.issue_number > 0 &&
    hasParentIssueNumber === hasParentIssueUrl
  );
}

export function buildTaskIssueSourceFingerprint(input: {
  issueNumber: number;
  title: string;
  body: string;
  issueUrl?: string;
  state?: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        issue_number: Number(input.issueNumber || 0),
        title: String(input.title || "").trim(),
        body: normalizeIssueBodyForComparison(String(input.body || "")),
        issue_url: String(input.issueUrl || "").trim(),
        state: String(input.state || "")
          .trim()
          .toLowerCase(),
      })
    )
    .digest("hex");
}

export function writeVerifiedTaskIssueMarker(
  repoRoot: string,
  marker: VerifiedTaskIssueMarker
): string {
  const markerPath = path.resolve(
    repoRoot,
    resolveGitPath(repoRoot, taskIssueMarkerRelativePath(marker.branch))
  );
  mkdirSync(path.dirname(markerPath), { recursive: true });
  writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
  return markerPath;
}

export function readTaskIssueSnapshot(repoRoot: string, branch: string): TaskIssueSnapshot | null {
  const snapshotPath = path.resolve(
    repoRoot,
    resolveGitPath(repoRoot, taskIssueSnapshotRelativePath(branch))
  );
  if (!existsSync(snapshotPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(snapshotPath, "utf8")) as Partial<TaskIssueSnapshot>;
    if (
      parsed?.version !== 1 ||
      typeof parsed.branch !== "string" ||
      typeof parsed.task_id !== "string" ||
      typeof parsed.repository !== "string" ||
      typeof parsed.source_fingerprint !== "string"
    ) {
      return null;
    }
    return parsed as TaskIssueSnapshot;
  } catch {
    return null;
  }
}

export function isTaskIssueSnapshotCurrent(
  snapshot: TaskIssueSnapshot | null,
  options: { repository: string; branch: string; taskId: string; sourceFingerprint?: string }
): boolean {
  if (!snapshot) {
    return false;
  }

  const hasParentIssueNumber =
    Number.isInteger(snapshot.parent_issue_number) && Number(snapshot.parent_issue_number) > 0;
  const hasParentIssueUrl = Boolean(String(snapshot.parent_issue_url || "").trim());
  const expectedFingerprint = String(options.sourceFingerprint || "").trim();
  const actualFingerprint = String(snapshot.source_fingerprint || "").trim();

  return (
    snapshot.version === 1 &&
    snapshot.repository === options.repository &&
    snapshot.branch === options.branch &&
    snapshot.task_id === normalizeTaskId(options.taskId) &&
    Number.isInteger(snapshot.issue_number) &&
    snapshot.issue_number > 0 &&
    Boolean(String(snapshot.issue_url || "").trim()) &&
    hasParentIssueNumber === hasParentIssueUrl &&
    Boolean(actualFingerprint) &&
    (!expectedFingerprint || actualFingerprint === expectedFingerprint)
  );
}

export function writeTaskIssueSnapshot(repoRoot: string, snapshot: TaskIssueSnapshot): string {
  const snapshotPath = path.resolve(
    repoRoot,
    resolveGitPath(repoRoot, taskIssueSnapshotRelativePath(snapshot.branch))
  );
  mkdirSync(path.dirname(snapshotPath), { recursive: true });
  writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  return snapshotPath;
}

function normalizeSectionName(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function stripDeprecatedProjectOwnedSections(body: string): string {
  const lines = String(body || "")
    .replace(/\r\n/g, "\n")
    .split("\n");
  const kept: string[] = [];
  let skipCurrentSection = false;

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+?)\s*$/);
    if (headingMatch) {
      skipCurrentSection = DEPRECATED_PROJECT_OWNED_SECTIONS.has(
        normalizeSectionName(headingMatch[1] || "")
      );
    }
    if (!skipCurrentSection) {
      kept.push(line);
    }
  }

  return kept.join("\n").trim();
}

export function auditTaskIssueSourceOfTruth(input: {
  issue: TaskIssue;
  title: string;
  body: string;
}): TaskIssueSourceOfTruthAudit {
  const rebuilt = tryBuildTaskSpecFromIssueSnapshot({
    title: input.title,
    body: input.body,
    metadata: input.issue.metadata,
  });
  const deprecatedOnlyFailure =
    !rebuilt.spec &&
    rebuilt.errors.length > 0 &&
    rebuilt.errors.every((error) => error.includes("unsupported in canonical task issue body"));
  const normalizedInputBody = deprecatedOnlyFailure
    ? stripDeprecatedProjectOwnedSections(input.body)
    : input.body;
  const normalizedRebuilt = deprecatedOnlyFailure
    ? tryBuildTaskSpecFromIssueSnapshot({
        title: input.title,
        body: normalizedInputBody,
        metadata: input.issue.metadata,
      })
    : rebuilt;
  const taskId = String(input.issue.metadata.task_id || "").trim();

  if (!normalizedRebuilt.spec || normalizedRebuilt.errors.length > 0) {
    return {
      issue_number: input.issue.number,
      task_id: taskId,
      errors: normalizedRebuilt.errors,
      mismatches: [],
      normalized_title: "",
      normalized_body: "",
      can_apply: false,
    };
  }

  const normalizedTitle = normalizedRebuilt.spec.title.trim();
  const normalizedBody = normalizeIssueBodyForComparison(renderIssueBody(normalizedRebuilt.spec));
  const currentTitle = String(input.title || "").trim();
  const currentBody = normalizeIssueBodyForComparison(input.body);
  const mismatches: string[] = [];

  if (currentTitle !== normalizedTitle) {
    mismatches.push(
      `title drift (expected='${normalizedTitle || "(empty)"}', actual='${currentTitle || "(empty)"}')`
    );
  }
  if (currentBody !== normalizedBody) {
    mismatches.push("body drift");
  }
  if (deprecatedOnlyFailure) {
    mismatches.push("deprecated Project-owned sections are present in the issue body");
  }

  return {
    issue_number: input.issue.number,
    task_id: normalizedRebuilt.spec.task_id,
    errors: [],
    mismatches,
    normalized_title: normalizedTitle,
    normalized_body: normalizedBody,
    can_apply: mismatches.length > 0,
  };
}
