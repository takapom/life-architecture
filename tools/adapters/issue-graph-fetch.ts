import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  assertNoRetiredProjectNumberEnv,
  extractIssueNumbers,
  extractLabels,
  extractTaskIdFromIssueBody,
  extractTaskIdFromIssueTitle,
  type GraphIssueNode,
  normalizeSourceIssue,
  parseIssueState,
  parseTaskMetadata,
  type RepositoryRef,
  resolveRepository,
  TASK_ID_PATTERN,
  type TaskIssue,
  type TaskMetadata,
} from "../core/issue-graph-types";
import {
  GH_COMMAND_TIMEOUT_MS,
  GH_TRANSIENT_RETRY_DELAYS_MS,
  isTransientGhFailureDetail,
  sleepSync,
} from "./cli";

// ─── Phase A: REST issue metadata + hierarchy summary ───────────────────────

type RestIssueData = {
  number: number;
  title: string;
  state: string;
  body: string;
  url: string;
  id: string;
  labels: Array<string | { name?: string }>;
  parentIssueNumber: number | null;
  blockedByCount: number;
  subIssueCount: number;
};

type TaskIssueLoadState = "all" | "open";

export type CanonicalTaskIssueSummary = {
  body: string;
  htmlUrl: string;
  metadata: Pick<
    TaskMetadata,
    | "acceptance_checks"
    | "admission_mode"
    | "allowed_files"
    | "deps"
    | "global_invariant"
    | "task_id"
    | "tests"
    | "unfreeze_condition"
  >;
  number: number;
  state: "OPEN" | "CLOSED";
  taskId: string;
  title: string;
};

export type BoundedTaskIssueOverlayRequest = {
  issueNumber?: number;
  taskId: string;
};

type IssueProjectLookupPayload = {
  data?: {
    repository?: {
      issue?: {
        number?: unknown;
        url?: unknown;
        title?: unknown;
        body?: unknown;
        state?: unknown;
        labels?: {
          nodes?: Array<{ name?: unknown }>;
        } | null;
        parent?: {
          number?: unknown;
        } | null;
        blockedBy?: {
          nodes?: unknown[];
        } | null;
        subIssues?: {
          nodes?: unknown[];
        } | null;
        projectItems?: {
          nodes?: unknown[];
        } | null;
      } | null;
    } | null;
  } | null;
};

const GH_ISSUE_LIST_MAX_BUFFER_BYTES = 32 * 1024 * 1024; // 32 MiB
const GH_TASK_ISSUE_LOOKUP_MAX_BUFFER_BYTES = 8 * 1024 * 1024; // 8 MiB
const ERROR_DETAIL_MAX_CHARS = 4_096;

function hasRateLimitFailureDetail(detail: string): boolean {
  const normalized = detail.toLowerCase();
  return (
    normalized.includes("rate limit") ||
    normalized.includes("secondary rate limit") ||
    normalized.includes("too many requests")
  );
}

export function resolveCanonicalTaskIssueSourcePath(explicitSourcePath?: string): string {
  const sourcePath = String(explicitSourcePath || "").trim();
  if (sourcePath) return sourcePath;
  // biome-ignore lint/style/noProcessEnv: canonical worker-facing task issue source env is intentionally part of the runtime contract.
  const taskIssueSourcePath = String(process.env.OMTA_TASK_ISSUE_SOURCE || "").trim();
  if (taskIssueSourcePath) return taskIssueSourcePath;
  // biome-ignore lint/style/noProcessEnv: issue-graph source resolution is intentionally driven by the canonical env contract.
  const canonicalSourcePath = String(process.env.ISSUE_GRAPH_SOURCE || "").trim();
  if (canonicalSourcePath) return canonicalSourcePath;
  // biome-ignore lint/style/noProcessEnv: retired env detection must inspect the live process environment to fail closed.
  const retiredSourcePath = String(process.env.ISSUE_DAG_SOURCE || "").trim();
  if (retiredSourcePath) {
    throw new Error(
      "ISSUE_DAG_SOURCE is retired; set ISSUE_GRAPH_SOURCE explicitly or pass --source-path"
    );
  }
  return "";
}

function truncateErrorDetail(detail: string): string {
  if (detail.length <= ERROR_DETAIL_MAX_CHARS) {
    return detail;
  }
  return `${detail.slice(0, ERROR_DETAIL_MAX_CHARS)} …(truncated)`;
}

function formatSpawnFailure(result: SpawnSyncReturns<string>, maxBufferBytes: number): string {
  if (result.error) {
    const errorCode = (result.error as NodeJS.ErrnoException).code;
    if (errorCode === "ENOBUFS") {
      return `command output exceeded maxBuffer=${maxBufferBytes} bytes`;
    }
    return result.error.message;
  }

  const detail = `${result.stderr || ""}\n${result.stdout || ""}`.trim();
  if (!detail) {
    return `exit=${result.status ?? "unknown"}`;
  }
  return truncateErrorDetail(detail);
}

function runGhCommand(args: string[], maxBufferBytes: number): SpawnSyncReturns<string> {
  // biome-ignore lint/style/noProcessEnv: repo tooling resolves the gh binary from the process environment.
  const ghBin = process.env.OMTA_GH_BIN?.trim() || "gh";
  let lastResult: SpawnSyncReturns<string> | null = null;

  for (let attempt = 0; attempt <= GH_TRANSIENT_RETRY_DELAYS_MS.length; attempt += 1) {
    const result = spawnSync(ghBin, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: maxBufferBytes,
      timeout: GH_COMMAND_TIMEOUT_MS,
    });
    if (!result.error && result.status === 0) {
      return result;
    }

    lastResult = result;
    const detail = formatSpawnFailure(result, maxBufferBytes);
    if (
      attempt === GH_TRANSIENT_RETRY_DELAYS_MS.length ||
      (result.error as NodeJS.ErrnoException | undefined)?.code === "ENOBUFS" ||
      !(isTransientGhFailureDetail(detail) || hasRateLimitFailureDetail(detail))
    ) {
      break;
    }
    sleepSync(GH_TRANSIENT_RETRY_DELAYS_MS[attempt] || 0);
  }

  return (
    lastResult ?? {
      pid: 0,
      output: ["", "", ""],
      stdout: "",
      stderr: "gh command did not execute",
      status: 1,
      signal: null,
      error: undefined,
    }
  );
}

function parseIssueNumberFromApiUrl(value: unknown): number | null {
  const text = String(value || "").trim();
  if (!text) return null;
  const matched = text.match(/\/issues\/(\d+)\/?$/);
  if (!matched) return null;
  const number = Number(matched[1] || 0);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function normalizeTaskIdValue(value: string): string {
  return String(value || "").trim();
}

function normalizeRequestedIssueNumbers(values?: number[]): number[] {
  return [
    ...new Set(
      (values || [])
        .map((value) => Number(value || 0))
        .filter((value) => Number.isInteger(value) && value > 0)
    ),
  ];
}

function normalizeBoundedTaskIssueOverlayRequests(
  values?: ReadonlyArray<BoundedTaskIssueOverlayRequest>
): BoundedTaskIssueOverlayRequest[] {
  const byTaskId = new Map<string, BoundedTaskIssueOverlayRequest>();

  for (const entry of values || []) {
    const taskId = normalizeTaskIdValue(entry.taskId);
    if (!taskId) {
      continue;
    }
    const issueNumber = Number(entry.issueNumber || 0);
    byTaskId.set(taskId, {
      taskId,
      ...(Number.isInteger(issueNumber) && issueNumber > 0 ? { issueNumber } : {}),
    });
  }

  return [...byTaskId.values()].sort((left, right) => left.taskId.localeCompare(right.taskId));
}

function filterIssuesForRequest(
  issues: TaskIssue[],
  state: TaskIssueLoadState,
  issueNumbers: number[]
): TaskIssue[] {
  const allowedIssueNumbers = issueNumbers.length > 0 ? new Set(issueNumbers) : null;
  return issues.filter((issue) => {
    if (state === "open" && issue.state !== "open") return false;
    if (allowedIssueNumbers && !allowedIssueNumbers.has(issue.number)) return false;
    return true;
  });
}

function resolveSingleTaskIssue(
  issues: TaskIssue[],
  taskId: string,
  state: TaskIssueLoadState = "open"
): TaskIssue {
  const normalizedTaskId = normalizeTaskIdValue(taskId);
  if (!TASK_ID_PATTERN.test(normalizedTaskId)) {
    throw new Error(`task_id is invalid: ${taskId}`);
  }

  const matched = issues.filter((issue) => {
    if (normalizeTaskIdValue(issue.metadata.task_id) !== normalizedTaskId) {
      return false;
    }
    if (state === "open" && issue.state !== "open") {
      return false;
    }
    return true;
  });

  if (matched.length === 0) {
    throw new Error(
      state === "open"
        ? `no open GitHub task issue found for ${normalizedTaskId}. Create or normalize the canonical task issue before implementation.`
        : `no canonical GitHub task issue found for ${normalizedTaskId}. Create or normalize the canonical task issue before implementation.`
    );
  }

  if (matched.length > 1) {
    throw new Error(
      `multiple ${state === "open" ? "open " : ""}GitHub task issues found for ${normalizedTaskId}: ${matched.map((issue) => `#${issue.number}`).join(", ")}`
    );
  }

  return matched[0] as TaskIssue;
}

function parseRestIssueData(entry: unknown): RestIssueData | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }

  const raw = entry as Record<string, unknown>;
  if (raw.pull_request) return null;

  const dependencySummary =
    raw.issue_dependencies_summary &&
    typeof raw.issue_dependencies_summary === "object" &&
    !Array.isArray(raw.issue_dependencies_summary)
      ? (raw.issue_dependencies_summary as Record<string, unknown>)
      : {};

  const blockedByCount = Number(
    dependencySummary.total_blocked_by ?? dependencySummary.blocked_by ?? 0
  );
  const subIssuesSummary =
    raw.sub_issues_summary &&
    typeof raw.sub_issues_summary === "object" &&
    !Array.isArray(raw.sub_issues_summary)
      ? (raw.sub_issues_summary as Record<string, unknown>)
      : {};
  const subIssueCount = Number(subIssuesSummary.total ?? 0);

  return {
    number: Number(raw.number || 0),
    title: String(raw.title || ""),
    state: String(raw.state || "OPEN"),
    body: String(raw.body || ""),
    url: String(raw.html_url || raw.url || ""),
    id: String(raw.id || ""),
    labels: Array.isArray(raw.labels) ? raw.labels : [],
    parentIssueNumber: parseIssueNumberFromApiUrl(raw.parent_issue_url),
    blockedByCount: Number.isInteger(blockedByCount) && blockedByCount > 0 ? blockedByCount : 0,
    subIssueCount: Number.isInteger(subIssueCount) && subIssueCount > 0 ? subIssueCount : 0,
  };
}

function fetchIssueMetadataRest(
  repository: RepositoryRef,
  options?: {
    state?: TaskIssueLoadState;
    issueNumbers?: number[];
  }
): RestIssueData[] {
  const slug = `${repository.owner}/${repository.repo}`;
  const requestedIssueNumbers = normalizeRequestedIssueNumbers(options?.issueNumbers);
  const requestedState = options?.state === "open" ? "open" : "all";
  const out: RestIssueData[] = [];

  if (requestedIssueNumbers.length > 0) {
    for (const issueNumber of requestedIssueNumbers) {
      const endpoint = `repos/${slug}/issues/${issueNumber}`;
      const result = runGhCommand(["api", endpoint], GH_TASK_ISSUE_LOOKUP_MAX_BUFFER_BYTES);

      if (result.error || result.status !== 0) {
        throw new Error(
          `gh api ${endpoint} failed: ${formatSpawnFailure(result, GH_TASK_ISSUE_LOOKUP_MAX_BUFFER_BYTES)}`
        );
      }

      const parsed = JSON.parse(result.stdout || "null") as unknown;
      const issue = parseRestIssueData(parsed);
      if (!issue) continue;
      if (requestedState === "open" && parseIssueState(issue.state) !== "open") {
        continue;
      }
      out.push(issue);
    }
    return out;
  }

  let page = 1;

  for (;;) {
    const endpoint = `repos/${slug}/issues?labels=task&state=${requestedState}&per_page=100&page=${page}`;
    const result = runGhCommand(["api", endpoint], GH_ISSUE_LIST_MAX_BUFFER_BYTES);

    if (result.error || result.status !== 0) {
      throw new Error(
        `gh api ${endpoint} failed: ${formatSpawnFailure(result, GH_ISSUE_LIST_MAX_BUFFER_BYTES)}`
      );
    }

    const parsed = JSON.parse(result.stdout || "[]") as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error(`gh api ${endpoint} response must be a JSON array`);
    }
    if (parsed.length === 0) {
      break;
    }

    for (const entry of parsed) {
      const issue = parseRestIssueData(entry);
      if (!issue) continue;
      out.push(issue);
    }

    if (parsed.length < 100) {
      break;
    }
    page += 1;
  }

  return out;
}

function runGhJson(args: string[], maxBufferBytes: number): unknown {
  const result = runGhCommand(args, maxBufferBytes);

  if (result.error || result.status !== 0) {
    throw new Error(`gh ${args.join(" ")} failed: ${formatSpawnFailure(result, maxBufferBytes)}`);
  }

  return JSON.parse(result.stdout || "null") as unknown;
}

function uniqueTaskIds(values: string[]): string[] {
  return [...new Set(values.map((value) => normalizeTaskIdValue(value)).filter(Boolean))];
}

function hydrateNativeDependencyTaskIds(issues: TaskIssue[]): TaskIssue[] {
  const byIssueNumber = new Map<number, TaskIssue>(
    issues
      .filter((issue) => Number.isInteger(issue.number) && issue.number > 0)
      .map((issue) => [issue.number, issue])
  );

  return issues.map((issue) => {
    const derivedDeps = uniqueTaskIds([
      ...issue.metadata.deps,
      ...issue.graph.blockedBy.map(
        (blockedByIssueNumber) => byIssueNumber.get(blockedByIssueNumber)?.metadata.task_id || ""
      ),
    ]);

    return {
      ...issue,
      dependencySource: derivedDeps.length > 0 ? "native-issue-link" : "none",
      metadata: {
        ...issue.metadata,
        deps: derivedDeps,
      },
    };
  });
}

function buildGraphIssueNode(raw: unknown): GraphIssueNode | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }

  const issue = raw as Record<string, unknown>;
  return normalizeSourceIssue({
    id: issue.id ? String(issue.id) : undefined,
    number: Number(issue.number || 0),
    title: String(issue.title || "").trim(),
    state: String(issue.state || "OPEN"),
    url: String(issue.url || ""),
    html_url: String(issue.url || ""),
    body: issue.body === null ? null : String(issue.body || ""),
    labels:
      issue.labels && typeof issue.labels === "object"
        ? (issue.labels as GraphIssueNode["labels"])
        : undefined,
    blockedBy:
      issue.blockedBy && typeof issue.blockedBy === "object"
        ? (issue.blockedBy as GraphIssueNode["blockedBy"])
        : undefined,
    parent:
      issue.parent && typeof issue.parent === "object"
        ? (issue.parent as GraphIssueNode["parent"])
        : undefined,
    subIssues:
      issue.subIssues && typeof issue.subIssues === "object"
        ? (issue.subIssues as GraphIssueNode["subIssues"])
        : undefined,
    projectItems:
      issue.projectItems && typeof issue.projectItems === "object"
        ? (issue.projectItems as GraphIssueNode["projectItems"])
        : undefined,
    project_fields:
      issue.project_fields && typeof issue.project_fields === "object"
        ? (issue.project_fields as GraphIssueNode["project_fields"])
        : undefined,
  });
}

function resolveTaskIdFromGraphIssueNode(node: GraphIssueNode): string {
  const labels = extractLabels(node.labels);
  const metadata = parseTaskMetadata({
    issueNumber: node.number,
    title: node.title,
    state: parseIssueState(node.state),
    labels,
    source: node,
  });

  const taskIdFromMetadata = normalizeTaskIdValue(metadata.task_id);
  if (taskIdFromMetadata) {
    return taskIdFromMetadata;
  }

  const taskIdFromBody = extractTaskIdFromIssueBody(node.body).trim();
  const taskIdFromTitle = String(
    node.title.match(/\b([A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*-\d{3,}[a-z]?)\b/u)?.[1] || ""
  ).trim();
  return normalizeTaskIdValue(taskIdFromBody || taskIdFromTitle);
}

function buildCanonicalTaskIssueSummaryFromGraphIssueNode(
  node: GraphIssueNode
): CanonicalTaskIssueSummary | null {
  if (node.pull_request) {
    return null;
  }

  const labels = extractLabels(node.labels);
  if (!labels.includes("task")) {
    return null;
  }

  const state = parseIssueState(node.state);
  const metadata = parseTaskMetadata({
    issueNumber: node.number,
    title: node.title,
    state,
    labels,
    source: node,
  });
  const taskId = resolveTaskIdFromGraphIssueNode(node);
  if (!taskId) {
    return null;
  }

  return {
    body: String(node.body || ""),
    htmlUrl: String(node.html_url || node.url || ""),
    metadata: {
      acceptance_checks: metadata.acceptance_checks,
      admission_mode: metadata.admission_mode,
      allowed_files: metadata.allowed_files,
      deps: metadata.deps,
      global_invariant: metadata.global_invariant,
      task_id: taskId,
      tests: metadata.tests,
      unfreeze_condition: metadata.unfreeze_condition,
    },
    number: node.number,
    state: state === "closed" ? "CLOSED" : "OPEN",
    taskId,
    title: node.title,
  };
}

function resolveTaskIdFromRestIssueData(issue: RestIssueData): string {
  const taskIdFromTitle = normalizeTaskIdValue(extractTaskIdFromIssueTitle(issue.title));
  if (taskIdFromTitle) {
    return taskIdFromTitle;
  }

  const taskIdFromBody = normalizeTaskIdValue(extractTaskIdFromIssueBody(issue.body));
  if (taskIdFromBody) {
    return taskIdFromBody;
  }

  const titleTaskIdMatch = String(issue.title || "").match(
    /\b([A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*-\d{3,}[a-z]?)\b/u
  );
  return normalizeTaskIdValue(String(titleTaskIdMatch?.[1] || "").trim());
}

function buildTaskIssueFromRestIssueData(
  issue: RestIssueData,
  options?: { subIssueNumbers?: number[] }
): TaskIssue {
  const labels = extractLabels(issue.labels);
  const state = parseIssueState(issue.state);
  const source: GraphIssueNode = {
    id: issue.id || `ISSUE_${issue.number}`,
    number: issue.number,
    title: issue.title,
    state: issue.state,
    url: issue.url,
    html_url: issue.url,
    body: issue.body,
    labels: labels.map((name) => ({ name })),
    parent: issue.parentIssueNumber ? { number: issue.parentIssueNumber } : null,
    subIssues: (options?.subIssueNumbers || []).map((number) => ({ number })),
  };
  const metadataBase = parseTaskMetadata({
    issueNumber: issue.number,
    title: source.title,
    state,
    labels,
    source,
  });
  const metadata = {
    ...metadataBase,
    task_id: resolveTaskIdFromRestIssueData(issue),
  };

  return {
    id: issue.id || `ISSUE_${issue.number}`,
    number: issue.number,
    title: issue.title,
    state,
    htmlUrl: issue.url,
    labels,
    dependencySource: "none",
    metadata,
    graph: {
      blockedBy: [],
      parent: issue.parentIssueNumber,
      subIssues: options?.subIssueNumbers || [],
    },
  };
}

function buildCanonicalTaskIssueSummaryFromRestIssueData(
  issue: RestIssueData
): CanonicalTaskIssueSummary | null {
  const labels = extractLabels(issue.labels);
  const source: GraphIssueNode = {
    body: issue.body,
    id: issue.id || `ISSUE_${issue.number}`,
    labels: labels.map((name) => ({ name })),
    number: issue.number,
    parent: issue.parentIssueNumber ? { number: issue.parentIssueNumber } : null,
    state: issue.state,
    subIssues: [],
    title: issue.title,
    url: issue.url,
    html_url: issue.url,
  };
  const metadata = parseTaskMetadata({
    issueNumber: issue.number,
    labels,
    source,
    state: parseIssueState(issue.state),
    title: issue.title,
  });
  const taskId = resolveTaskIdFromRestIssueData(issue);
  if (!taskId || !Number.isInteger(issue.number) || issue.number <= 0) {
    return null;
  }

  return {
    body: issue.body,
    htmlUrl: issue.url,
    metadata: {
      acceptance_checks: metadata.acceptance_checks,
      admission_mode: metadata.admission_mode,
      allowed_files: metadata.allowed_files,
      deps: metadata.deps,
      global_invariant: metadata.global_invariant,
      task_id: taskId,
      tests: metadata.tests,
      unfreeze_condition: metadata.unfreeze_condition,
    },
    number: issue.number,
    state: parseIssueState(issue.state) === "closed" ? "CLOSED" : "OPEN",
    taskId,
    title: issue.title,
  };
}

function fetchSubIssueNumbersRest(repository: RepositoryRef, issueNumber: number): number[] {
  const slug = `${repository.owner}/${repository.repo}`;
  const subIssueNumbers = new Set<number>();

  for (let page = 1; ; page += 1) {
    const endpoint = `repos/${slug}/issues/${issueNumber}/sub_issues?per_page=100&page=${page}`;
    const result = runGhCommand(["api", endpoint], GH_TASK_ISSUE_LOOKUP_MAX_BUFFER_BYTES);

    if (result.error || result.status !== 0) {
      throw new Error(
        `gh api ${endpoint} failed: ${formatSpawnFailure(result, GH_TASK_ISSUE_LOOKUP_MAX_BUFFER_BYTES)}`
      );
    }

    const parsed = JSON.parse(result.stdout || "[]") as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error(`gh api ${endpoint} response must be a JSON array`);
    }

    for (const entry of parsed) {
      const number = Number(
        entry && typeof entry === "object" && !Array.isArray(entry)
          ? (entry as { number?: unknown }).number || 0
          : 0
      );
      if (Number.isInteger(number) && number > 0) {
        subIssueNumbers.add(number);
      }
    }

    if (parsed.length < 100) {
      break;
    }
  }

  return [...subIssueNumbers].sort((left, right) => left - right);
}

function loadResolvedRestTaskIssue(repository: RepositoryRef, restIssue: RestIssueData): TaskIssue {
  const subIssueNumbers =
    restIssue.subIssueCount > 0 ? fetchSubIssueNumbersRest(repository, restIssue.number) : [];
  return buildTaskIssueFromRestIssueData(restIssue, { subIssueNumbers });
}

function assertResolvedTaskIssueMatchesTaskId(
  issue: TaskIssue,
  taskId: string,
  context: string
): void {
  if (normalizeTaskIdValue(issue.metadata.task_id) === normalizeTaskIdValue(taskId)) {
    return;
  }

  throw new Error(
    `${context} resolved to #${issue.number}, but its canonical task_id is ${issue.metadata.task_id || "missing"} instead of ${taskId}`
  );
}

function fetchTaskIssueByCandidate(
  repository: RepositoryRef,
  issueNumber: number
): TaskIssue | null {
  const payload = runGhJson(
    [
      "api",
      "graphql",
      "-f",
      "query=query($owner:String!, $repo:String!, $number:Int!) { repository(owner:$owner, name:$repo) { issue(number:$number) { number title body url state labels(first:20) { nodes { name } } parent { number } blockedBy(first:20) { nodes { number title body state url labels(first:20) { nodes { name } } } } subIssues(first:20) { nodes { number } } } } }",
      "-F",
      `owner=${repository.owner}`,
      "-F",
      `repo=${repository.repo}`,
      "-F",
      `number=${issueNumber}`,
    ],
    GH_TASK_ISSUE_LOOKUP_MAX_BUFFER_BYTES
  ) as IssueProjectLookupPayload;

  const issue = payload.data?.repository?.issue;
  if (!issue) {
    return null;
  }

  const labels = extractLabels(issue.labels?.nodes || []);
  if (!labels.includes("task")) {
    return null;
  }

  const state = parseIssueState(String(issue.state || "OPEN"));
  const source: GraphIssueNode = {
    id: `ISSUE_${issueNumber}`,
    number: Number(issue.number || issueNumber),
    title: String(issue.title || `Task #${issueNumber}`),
    state: String(issue.state || "OPEN"),
    url: String(issue.url || ""),
    html_url: String(issue.url || ""),
    body: String(issue.body || ""),
    labels: labels.map((name) => ({ name })),
    blockedBy: issue.blockedBy?.nodes || [],
    parent: issue.parent ? { number: Number(issue.parent.number || 0) } : null,
    subIssues: issue.subIssues?.nodes || [],
  };

  const metadataBase = parseTaskMetadata({
    issueNumber: Number(issue.number || issueNumber),
    title: source.title,
    state,
    labels,
    source,
  });

  let resolvedTaskId = normalizeTaskIdValue(metadataBase.task_id);
  if (!resolvedTaskId) {
    const taskIdFromBody = extractTaskIdFromIssueBody(source.body).trim();
    const titleTaskIdMatch = String(source.title || "").match(
      /\b([A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*-\d{3,}[a-z]?)\b/u
    );
    const taskIdFromTitle = String(titleTaskIdMatch?.[1] || "").trim();
    resolvedTaskId = taskIdFromBody || taskIdFromTitle;
  }
  const dependencyTaskIds = uniqueTaskIds(
    extractIssueNumbers(issue.blockedBy?.nodes || [])
      .map((blockedByIssueNumber) => {
        const blockedByNode = Array.isArray(issue.blockedBy?.nodes)
          ? issue.blockedBy.nodes.find(
              (node) =>
                node &&
                typeof node === "object" &&
                !Array.isArray(node) &&
                Number((node as { number?: unknown }).number || 0) === blockedByIssueNumber
            )
          : undefined;
        const graphNode = buildGraphIssueNode(blockedByNode);
        if (!graphNode) return "";
        return resolveTaskIdFromGraphIssueNode(graphNode);
      })
      .filter(Boolean)
  );
  const metadata = {
    ...metadataBase,
    task_id: resolvedTaskId,
    deps: dependencyTaskIds,
  };

  return {
    id: `ISSUE_${issueNumber}`,
    number: Number(issue.number || issueNumber),
    title: source.title,
    state,
    htmlUrl: String(issue.html_url || issue.url || ""),
    labels,
    dependencySource: metadata.deps.length > 0 ? "native-issue-link" : "none",
    metadata,
    graph: {
      blockedBy: extractIssueNumbers(issue.blockedBy?.nodes || []),
      parent: Number(issue.parent?.number || 0) || null,
      subIssues: extractIssueNumbers(issue.subIssues?.nodes || []),
    },
  };
}

export async function loadTaskIssueByTaskIdFromControlPlane(options: {
  taskId: string;
  repository: string | RepositoryRef;
  issueNumber?: number;
  state?: TaskIssueLoadState;
}): Promise<{
  repository: RepositoryRef;
  issue: TaskIssue;
}> {
  await Promise.resolve();
  assertNoRetiredProjectNumberEnv();
  const repository =
    typeof options.repository === "string"
      ? resolveRepository(options.repository)
      : options.repository;
  const taskId = normalizeTaskIdValue(options.taskId);
  const requestedIssueNumber = Number(options.issueNumber || 0);
  const requestedState = options.state === "all" ? "all" : "open";

  if (Number.isInteger(requestedIssueNumber) && requestedIssueNumber > 0) {
    const [restIssue] = fetchIssueMetadataRest(repository, {
      state: requestedState,
      issueNumbers: [requestedIssueNumber],
    });
    if (!restIssue) {
      throw new Error(
        requestedState === "open"
          ? `no open GitHub task issue found for ${taskId} at issue #${requestedIssueNumber}. Create or normalize the canonical task issue before implementation.`
          : `no canonical GitHub task issue found for ${taskId} at issue #${requestedIssueNumber}. Create or normalize the canonical task issue before implementation.`
      );
    }

    const issue = loadResolvedRestTaskIssue(repository, restIssue);
    assertResolvedTaskIssueMatchesTaskId(issue, taskId, "verified task issue marker");
    return { repository, issue };
  }

  const matchedRestIssues = fetchIssueMetadataRest(repository, {
    state: requestedState,
  }).filter((issue) => resolveTaskIdFromRestIssueData(issue) === taskId);
  const matchedIssues = matchedRestIssues.map((issue) =>
    loadResolvedRestTaskIssue(repository, issue)
  );

  return { repository, issue: resolveSingleTaskIssue(matchedIssues, taskId, requestedState) };
}

export async function loadTaskIssueByTaskId(options: {
  taskId: string;
  sourcePath?: string;
  repository?: string;
  issueNumber?: number;
  state?: TaskIssueLoadState;
}): Promise<{
  repository: RepositoryRef;
  issue: TaskIssue;
}> {
  await Promise.resolve();
  const repositoryValue = String(options.repository || "").trim();
  if (!repositoryValue) {
    throw new Error("repository is required");
  }
  const repository = resolveRepository(repositoryValue);
  const taskId = normalizeTaskIdValue(options.taskId);
  const sourcePath = resolveCanonicalTaskIssueSourcePath(options.sourcePath);
  const requestedIssueNumber = Number(options.issueNumber || 0);
  const requestedState = options.state === "all" ? "all" : "open";

  if (sourcePath) {
    const loaded = loadFromFile(sourcePath, repository);
    try {
      return {
        repository: loaded.repository,
        issue: resolveSingleTaskIssue(loaded.issues, taskId, requestedState),
      };
    } catch (error) {
      const message = String((error as Error)?.message || "");
      const missingIssue =
        message.startsWith(`no open GitHub task issue found for ${taskId}`) ||
        message.startsWith(`no canonical GitHub task issue found for ${taskId}`);
      if (!missingIssue) {
        throw error;
      }
      if (!Number.isInteger(requestedIssueNumber) || requestedIssueNumber <= 0) {
        throw new Error(
          `bounded task issue source ${sourcePath} does not contain ${taskId}, and no canonical issue number hint is available for single-task overlay`
        );
      }
      return loadTaskIssueByTaskIdFromControlPlane({
        taskId,
        repository,
        issueNumber: requestedIssueNumber,
        state: requestedState,
      });
    }
  }

  return loadTaskIssueByTaskIdFromControlPlane({
    taskId,
    repository,
    issueNumber: requestedIssueNumber,
    state: requestedState,
  });
}

export async function loadTaskIssueSummariesFromControlPlane(options: {
  repository: string | RepositoryRef;
  state?: TaskIssueLoadState;
  issueNumbers?: number[];
}): Promise<{
  repository: RepositoryRef;
  issues: CanonicalTaskIssueSummary[];
}> {
  await Promise.resolve();
  assertNoRetiredProjectNumberEnv();
  const repository =
    typeof options.repository === "string"
      ? resolveRepository(options.repository)
      : options.repository;
  const requestedState = options.state === "all" ? "all" : "open";
  const requestedIssueNumbers = normalizeRequestedIssueNumbers(options.issueNumbers);
  const restIssues = fetchIssueMetadataRest(repository, {
    state: requestedState,
    issueNumbers: requestedIssueNumbers,
  });
  const issuesByNumber = new Map<number, CanonicalTaskIssueSummary>();

  for (const issue of restIssues) {
    const summary = buildCanonicalTaskIssueSummaryFromRestIssueData(issue);
    if (!summary) {
      continue;
    }
    issuesByNumber.set(summary.number, summary);
  }

  return {
    repository,
    issues: [...issuesByNumber.values()].sort((left, right) => left.number - right.number),
  };
}

// ─── File-based source ───────────────────────────────────────────────────────

export function normalizeTaskIssueSourceNodes(
  payload: unknown,
  sourceLabel: string
): GraphIssueNode[] {
  if (Array.isArray(payload)) {
    return payload.map((entry) => normalizeSourceIssue(entry as GraphIssueNode));
  }

  if (
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    Array.isArray((payload as { issues?: unknown }).issues)
  ) {
    return ((payload as { issues: unknown[] }).issues || []).map((entry) =>
      normalizeSourceIssue(entry as GraphIssueNode)
    );
  }

  throw new Error(
    `ISSUE_GRAPH_SOURCE must be a JSON array or an object with an issues array: ${sourceLabel}`
  );
}

export function mergeTaskIssueIntoSource(
  existingSource: ReadonlyArray<GraphIssueNode>,
  singleIssue: GraphIssueNode
): GraphIssueNode[] {
  const merged = new Map<number, GraphIssueNode>();
  for (const issue of existingSource) {
    const normalized = normalizeSourceIssue(issue);
    const issueNumber = Number(normalized.number || 0);
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      continue;
    }
    merged.set(issueNumber, normalized);
  }
  const normalizedIssue = normalizeSourceIssue(singleIssue);
  const issueNumber = Number(normalizedIssue.number || 0);
  if (Number.isInteger(issueNumber) && issueNumber > 0) {
    merged.set(issueNumber, normalizedIssue);
  }
  return [...merged.values()].sort((left, right) => left.number - right.number);
}

export function loadTaskIssuesFromFile(sourcePath: string): GraphIssueNode[] {
  const absolute = path.resolve(sourcePath);
  const raw = readFileSync(absolute, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  return normalizeTaskIssueSourceNodes(parsed, absolute);
}

export function loadTaskIssuesFromSourceNodes(
  rawIssues: ReadonlyArray<GraphIssueNode>,
  repository: string | RepositoryRef,
  options?: {
    state?: TaskIssueLoadState;
    issueNumbers?: number[];
  }
): {
  repository: RepositoryRef;
  issues: TaskIssue[];
} {
  const resolvedRepository =
    typeof repository === "string" ? resolveRepository(repository) : repository;
  const issues: TaskIssue[] = [];

  for (const rawIssue of rawIssues) {
    const raw = normalizeSourceIssue(rawIssue);
    if (raw.pull_request) continue;
    const labels = extractLabels(raw.labels);
    if (!labels.includes("task")) continue;

    const state = parseIssueState(raw.state);
    const metadata = parseTaskMetadata({
      issueNumber: raw.number,
      title: raw.title,
      state,
      labels,
      source: raw,
    });

    issues.push({
      id: String(raw.id || `ISSUE_${raw.number}`),
      number: raw.number,
      title: raw.title,
      state,
      htmlUrl: String(raw.html_url || raw.url || ""),
      labels,
      dependencySource: metadata.deps.length > 0 ? "native-issue-link" : "none",
      metadata,
      graph: {
        blockedBy: extractIssueNumbers(raw.blockedBy),
        parent: extractIssueNumbers(raw.parent ? [raw.parent] : [])[0] ?? null,
        subIssues: extractIssueNumbers(raw.subIssues),
      },
    });
  }

  return {
    repository: resolvedRepository,
    issues: filterIssuesForRequest(
      hydrateNativeDependencyTaskIds(issues),
      options?.state === "open" ? "open" : "all",
      normalizeRequestedIssueNumbers(options?.issueNumbers)
    ),
  };
}

export function loadCanonicalTaskIssueSummariesFromFile(sourcePath: string): {
  issues: CanonicalTaskIssueSummary[];
} {
  return loadCanonicalTaskIssueSummariesFromSourceNodes(loadTaskIssuesFromFile(sourcePath));
}

export function loadCanonicalTaskIssueSummariesFromSourceNodes(
  sourceNodes: ReadonlyArray<GraphIssueNode>
): {
  issues: CanonicalTaskIssueSummary[];
} {
  const issuesByNumber = new Map<number, CanonicalTaskIssueSummary>();
  for (const issue of sourceNodes) {
    const summary = buildCanonicalTaskIssueSummaryFromGraphIssueNode(issue);
    if (!summary) {
      continue;
    }
    issuesByNumber.set(summary.number, summary);
  }
  return {
    issues: [...issuesByNumber.values()].sort((left, right) => left.number - right.number),
  };
}

// ─── Main entry point ───────────────────────────────────────────────────────

export async function loadTaskIssues(options?: {
  overlayTaskIssueRequests?: ReadonlyArray<BoundedTaskIssueOverlayRequest>;
  sourcePath?: string;
  repository?: string;
  state?: TaskIssueLoadState;
  issueNumbers?: number[];
}): Promise<{
  repository: RepositoryRef;
  issues: TaskIssue[];
}> {
  await Promise.resolve();
  assertNoRetiredProjectNumberEnv();
  const sourcePath = resolveCanonicalTaskIssueSourcePath(options?.sourcePath);
  const repositoryValue = String(options?.repository || "").trim();
  if (!repositoryValue) {
    throw new Error("repository is required");
  }
  const repository = resolveRepository(repositoryValue);
  const requestedState = options?.state === "open" ? "open" : "all";
  const requestedIssueNumbers = normalizeRequestedIssueNumbers(options?.issueNumbers);
  const overlayTaskIssueRequests = normalizeBoundedTaskIssueOverlayRequests(
    options?.overlayTaskIssueRequests
  );

  // File-based source: use existing path (no REST API calls)
  if (sourcePath) {
    const loaded = loadFromFile(sourcePath, repository, {
      state: requestedState,
      issueNumbers: requestedIssueNumbers,
    });
    if (overlayTaskIssueRequests.length === 0) {
      return loaded;
    }

    const issuesByNumber = new Map<number, TaskIssue>(
      loaded.issues.map((issue) => [issue.number, issue] as const)
    );
    const loadedTaskIds = new Set(
      loaded.issues.map((issue) => normalizeTaskIdValue(issue.metadata.task_id)).filter(Boolean)
    );

    for (const request of overlayTaskIssueRequests) {
      if (loadedTaskIds.has(request.taskId)) {
        continue;
      }
      if (!Number.isInteger(request.issueNumber) || (request.issueNumber || 0) <= 0) {
        throw new Error(
          `bounded task issue source ${sourcePath} does not contain ${request.taskId}, and no canonical issue number hint is available for single-task overlay`
        );
      }
      const overlay = await loadTaskIssueByTaskIdFromControlPlane({
        issueNumber: request.issueNumber,
        repository,
        state: requestedState,
        taskId: request.taskId,
      });
      issuesByNumber.set(overlay.issue.number, overlay.issue);
      loadedTaskIds.add(request.taskId);
    }

    return {
      repository: loaded.repository,
      issues: [...issuesByNumber.values()].sort((left, right) => left.number - right.number),
    };
  }

  // 2-Phase REST source (issue metadata + project fields)
  return loadFromGitHub(repository, {
    state: requestedState,
    issueNumbers: requestedIssueNumbers,
  });
}

function loadFromFile(
  sourcePath: string,
  repository: RepositoryRef,
  options?: {
    state?: TaskIssueLoadState;
    issueNumbers?: number[];
  }
): {
  repository: RepositoryRef;
  issues: TaskIssue[];
} {
  return loadTaskIssuesFromSourceNodes(loadTaskIssuesFromFile(sourcePath), repository, options);
}

function loadFromGitHub(
  repository: RepositoryRef,
  options?: {
    state?: TaskIssueLoadState;
    issueNumbers?: number[];
  }
): {
  repository: RepositoryRef;
  issues: TaskIssue[];
} {
  const requestedState = options?.state === "open" ? "open" : "all";
  const requestedIssueNumbers = normalizeRequestedIssueNumbers(options?.issueNumbers);
  const restIssues = fetchIssueMetadataRest(repository, {
    state: requestedState,
    issueNumbers: requestedIssueNumbers,
  });
  const issues = hydrateNativeDependencyTaskIds(
    restIssues
      .map((restIssue) => fetchTaskIssueByCandidate(repository, restIssue.number))
      .filter((issue): issue is TaskIssue => issue !== null)
  );

  return {
    repository,
    issues: filterIssuesForRequest(issues, requestedState, requestedIssueNumbers),
  };
}
