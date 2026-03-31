import { type SpawnSyncReturns, spawnSync } from "node:child_process";

import {
  GH_COMMAND_TIMEOUT_MS,
  GH_TRANSIENT_RETRY_DELAYS_MS,
  isTransientGhFailureDetail,
  sleepSync,
} from "./cli";

export type ProjectFieldOption = {
  id: string;
  name: string;
};

export type ProjectFieldDefinition = {
  restId: number;
  nodeId: string;
  name: string;
  dataType: string;
  options: ProjectFieldOption[];
};

export type ProjectRoute = {
  owner: string;
  projectNumber: number;
  apiRoute: string;
  restId: number;
  nodeId: string;
  title: string;
};

export type ProjectItem = {
  restId: number;
  nodeId: string;
  issueNumber: number;
  issueUrl: string;
  htmlUrl: string;
  contentType: string;
  title: string;
  fields: Record<string, string>;
};

export type ProjectFieldCatalog = {
  project: ProjectRoute;
  fields: ProjectFieldDefinition[];
  byName: Map<string, ProjectFieldDefinition>;
};

export type ProjectFieldMapResult = {
  project: ProjectRoute;
  catalog: ProjectFieldCatalog;
  byIssueNumber: Map<number, ProjectItem>;
  items: ProjectItem[];
};

export type ProjectAttachResult = {
  project: ProjectRoute;
  item: ProjectItem;
  attached: boolean;
};

type RestProjectPayload = {
  id?: unknown;
  node_id?: unknown;
  number?: unknown;
  title?: unknown;
};

type RestProjectFieldPayload = {
  id?: unknown;
  node_id?: unknown;
  name?: unknown;
  data_type?: unknown;
  options?: unknown;
};

type RestProjectItemField = {
  name?: unknown;
  value?: unknown;
};

type RestProjectItemPayload = {
  id?: unknown;
  node_id?: unknown;
  content?: unknown;
  content_type?: unknown;
  title?: unknown;
  fields?: unknown;
};

type RestIssuePayload = {
  id?: unknown;
  node_id?: unknown;
  number?: unknown;
  url?: unknown;
  html_url?: unknown;
  title?: unknown;
};

type ProjectCommandResult = Pick<
  SpawnSyncReturns<string>,
  "status" | "stdout" | "stderr" | "error"
>;

type GhJsonRunner = (endpoint: string, cwd?: string) => unknown;
type GhCommandRunner = (args: string[], cwd?: string, input?: string) => ProjectCommandResult;
type ProjectFieldIdentity = Pick<ProjectFieldDefinition, "restId" | "nodeId" | "name" | "dataType">;
type ProjectItemIdentity = Pick<ProjectItem, "restId" | "nodeId">;
type ProjectIssueReference = {
  restId: number;
  nodeId: string;
  issueNumber: number;
  apiUrl: string;
  htmlUrl: string;
  title: string;
};
type ProjectFieldValuePayload = string | number | null;

export type ProjectFieldValueUpdate = {
  field: ProjectFieldIdentity;
  value: string | number | null;
};

type BatchProjectFieldUpdateCliPayload = {
  project: Pick<
    ProjectRoute,
    "owner" | "projectNumber" | "apiRoute" | "restId" | "nodeId" | "title"
  >;
  item: ProjectItemIdentity;
  updates: ProjectFieldValueUpdate[];
  cwd?: string;
};

const GH_API_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const PROJECT_ITEMS_PAGE_SIZE = 100;
const PROJECT_ITEMS_FIELD_CHUNK_SIZE = 8;
const ERROR_DETAIL_MAX_CHARS = 4_096;
const PROJECT_ITEM_RESOLVE_RETRY_DELAYS_MS = [0, 250, 1_000];

function truncateErrorDetail(detail: string): string {
  if (detail.length <= ERROR_DETAIL_MAX_CHARS) {
    return detail;
  }
  return `${detail.slice(0, ERROR_DETAIL_MAX_CHARS)} …(truncated)`;
}

function formatSpawnFailure(result: ProjectCommandResult, maxBufferBytes: number): string {
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

function defaultRunGhCommand(args: string[], cwd?: string, input?: string): ProjectCommandResult {
  let lastResult: ProjectCommandResult | null = null;
  // biome-ignore lint/style/noProcessEnv: bounded adapter override for the gh binary is intentional runtime configuration.
  const ghBin = process.env.OMTA_GH_BIN?.trim() || "gh";

  for (let attempt = 0; attempt <= GH_TRANSIENT_RETRY_DELAYS_MS.length; attempt += 1) {
    const result = spawnSync(ghBin, args, {
      cwd: cwd ?? process.cwd(),
      encoding: "utf8",
      input,
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: GH_API_MAX_BUFFER_BYTES,
      timeout: GH_COMMAND_TIMEOUT_MS,
    });
    if (!result.error && result.status === 0) {
      return result;
    }
    lastResult = result;
    const detail = formatSpawnFailure(result, GH_API_MAX_BUFFER_BYTES);
    if (
      attempt === GH_TRANSIENT_RETRY_DELAYS_MS.length ||
      (result.error as NodeJS.ErrnoException | undefined)?.code === "ENOBUFS" ||
      !isTransientGhFailureDetail(detail)
    ) {
      break;
    }
    sleepSync(GH_TRANSIENT_RETRY_DELAYS_MS[attempt] || 0);
  }

  return (
    lastResult ?? {
      status: 1,
      stdout: "",
      stderr: "gh command did not execute",
      error: undefined,
    }
  );
}

function defaultRunGhJson(endpoint: string, cwd?: string): unknown {
  const result = defaultRunGhCommand(["api", endpoint], cwd);
  if (result.error || result.status !== 0) {
    throw new Error(
      `gh api ${endpoint} failed: ${formatSpawnFailure(result, GH_API_MAX_BUFFER_BYTES)}`
    );
  }

  const text = (result.stdout || "").trim();
  if (!text) return null;
  return JSON.parse(text) as unknown;
}

function defaultRunGhPaginated(endpoint: string, cwd?: string): unknown[] {
  if (endpoint.includes("/items?")) {
    const pages: unknown[] = [];
    let nextEndpoint = endpoint;
    while (nextEndpoint) {
      const result = defaultRunGhCommand(["api", "-i", nextEndpoint], cwd);
      if (result.error || result.status !== 0) {
        throw new Error(
          `gh api ${nextEndpoint} failed: ${formatSpawnFailure(result, GH_API_MAX_BUFFER_BYTES)}`
        );
      }
      const { headers, body } = parseGhApiIncludedResponse(result.stdout || "");
      const payload = JSON.parse(body || "[]") as unknown;
      if (!Array.isArray(payload)) {
        throw new Error(`gh api ${nextEndpoint} returned non-array paginated payload`);
      }
      pages.push(payload);
      nextEndpoint = nextProjectItemsEndpoint(headers);
    }
    return pages;
  }

  const result = defaultRunGhCommand(["api", endpoint, "--paginate", "--slurp"], cwd);
  if (result.error || result.status !== 0) {
    throw new Error(
      `gh api ${endpoint} failed: ${formatSpawnFailure(result, GH_API_MAX_BUFFER_BYTES)}`
    );
  }

  const payload = JSON.parse(result.stdout || "[]") as unknown;
  if (!Array.isArray(payload)) {
    throw new Error(`gh api ${endpoint} returned non-array paginated payload`);
  }
  return payload;
}

function unwrapProjectItemPayloadValue(payload: unknown, context: string): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`${context} returned a non-object payload`);
  }
  const record = payload as Record<string, unknown>;
  if (record.id || record.node_id) {
    return record;
  }
  const value = record.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} response is missing value payload`);
  }
  return value as Record<string, unknown>;
}

function parseUpdatedProjectItemPayload(payload: unknown): ProjectItemIdentity {
  const item = unwrapProjectItemPayloadValue(payload, "project field update");
  const restId = normalizePositiveInteger(item.id);
  const nodeId = normalizeText(item.node_id);
  if (!restId || !nodeId) {
    throw new Error("project field update response is missing item ids");
  }
  return { restId, nodeId };
}

function ensureProjectFieldDataType(
  field: ProjectFieldIdentity,
  expected: ProjectFieldDefinition["dataType"]
): void {
  if (field.dataType !== expected) {
    throw new Error(`project field '${field.name}' must be ${expected}`);
  }
}

function buildProjectFieldValuePayload(update: ProjectFieldValueUpdate): ProjectFieldValuePayload {
  if (update.value === null) {
    return null;
  }
  const field = update.field;
  const dataType = field.dataType.toUpperCase();
  if (dataType === "SINGLE_SELECT") {
    return String(update.value || "").trim();
  }
  if (dataType === "DATE") {
    let dateText = String(update.value || "").trim();
    if (dateText.includes("T")) {
      dateText = dateText.split("T", 1)[0] ?? "";
    }
    return dateText;
  }
  if (dataType === "NUMBER") {
    const parsed = Number(update.value);
    if (!Number.isFinite(parsed)) {
      throw new Error(`project field '${field.name}' must be NUMBER`);
    }
    return parsed;
  }
  return String(update.value ?? "").trim();
}

function runProjectItemFieldUpdate(
  options: {
    project: Pick<
      ProjectRoute,
      "owner" | "projectNumber" | "apiRoute" | "restId" | "nodeId" | "title"
    >;
    item: ProjectItemIdentity;
    updates: ProjectFieldValueUpdate[];
    cwd?: string;
  },
  runGhCommand: GhCommandRunner = defaultRunGhCommand
): void {
  if (options.updates.length === 0) {
    return;
  }

  const endpoint = `${options.project.apiRoute}/items/${options.item.restId}`;
  const fieldValues = options.updates.map((update) => {
    if (!update.field.restId) {
      throw new Error(`project field '${update.field.name}' is missing REST id`);
    }
    return {
      id: update.field.restId,
      value: buildProjectFieldValuePayload(update),
    };
  });
  const result = runGhCommand(
    ["api", endpoint, "--method", "PATCH", "--input", "-"],
    options.cwd,
    `${JSON.stringify({ fields: fieldValues })}\n`
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `gh api ${endpoint} failed: ${formatSpawnFailure(result, GH_API_MAX_BUFFER_BYTES)}`
    );
  }
  const updatedItem = parseUpdatedProjectItemPayload(JSON.parse(result.stdout || "{}"));
  if (updatedItem.restId !== options.item.restId) {
    throw new Error(
      `project field update returned mismatched item rest id: expected ${options.item.restId}, got ${updatedItem.restId}`
    );
  }
  if (updatedItem.nodeId !== options.item.nodeId) {
    throw new Error(
      `project field update returned mismatched item id: expected ${options.item.nodeId}, got ${updatedItem.nodeId}`
    );
  }
}

export function updateProjectItemFields(
  options: {
    project: Pick<
      ProjectRoute,
      "owner" | "projectNumber" | "apiRoute" | "restId" | "nodeId" | "title"
    >;
    item: ProjectItemIdentity;
    updates: ProjectFieldValueUpdate[];
    cwd?: string;
  },
  dependencies?: { runGhCommand?: GhCommandRunner }
): void {
  for (const update of options.updates) {
    const dataType = update.field.dataType.toUpperCase();
    if (dataType === "SINGLE_SELECT") {
      ensureProjectFieldDataType(update.field, "SINGLE_SELECT");
      continue;
    }
    if (dataType === "NUMBER") {
      ensureProjectFieldDataType(update.field, "NUMBER");
      continue;
    }
    if (dataType === "DATE") {
      ensureProjectFieldDataType(update.field, "DATE");
      continue;
    }
    ensureProjectFieldDataType(update.field, "TEXT");
  }
  runProjectItemFieldUpdate(options, dependencies?.runGhCommand);
}

export function updateProjectItemTextField(
  options: {
    project: Pick<
      ProjectRoute,
      "owner" | "projectNumber" | "apiRoute" | "restId" | "nodeId" | "title"
    >;
    item: ProjectItemIdentity;
    field: ProjectFieldIdentity;
    text: string;
    cwd?: string;
  },
  dependencies?: { runGhCommand?: GhCommandRunner }
): void {
  ensureProjectFieldDataType(options.field, "TEXT");
  updateProjectItemFields(
    {
      project: options.project,
      item: options.item,
      updates: [{ field: options.field, value: options.text }],
      cwd: options.cwd,
    },
    dependencies
  );
}

export function updateProjectItemNumberField(
  options: {
    project: Pick<
      ProjectRoute,
      "owner" | "projectNumber" | "apiRoute" | "restId" | "nodeId" | "title"
    >;
    item: ProjectItemIdentity;
    field: ProjectFieldIdentity;
    number: number;
    cwd?: string;
  },
  dependencies?: { runGhCommand?: GhCommandRunner }
): void {
  ensureProjectFieldDataType(options.field, "NUMBER");
  updateProjectItemFields(
    {
      project: options.project,
      item: options.item,
      updates: [{ field: options.field, value: options.number }],
      cwd: options.cwd,
    },
    dependencies
  );
}

export function updateProjectItemSingleSelectField(
  options: {
    project: Pick<
      ProjectRoute,
      "owner" | "projectNumber" | "apiRoute" | "restId" | "nodeId" | "title"
    >;
    item: ProjectItemIdentity;
    field: ProjectFieldIdentity;
    singleSelectOptionId: string;
    cwd?: string;
  },
  dependencies?: { runGhCommand?: GhCommandRunner }
): void {
  ensureProjectFieldDataType(options.field, "SINGLE_SELECT");
  updateProjectItemFields(
    {
      project: options.project,
      item: options.item,
      updates: [{ field: options.field, value: options.singleSelectOptionId }],
      cwd: options.cwd,
    },
    dependencies
  );
}

function normalizeText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function normalizePositiveInteger(value: unknown): number {
  const number = Number(value || 0);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

function parseRestFieldValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";

  const rawObject = value as Record<string, unknown>;
  const rawValue = rawObject.raw;
  if (typeof rawValue === "string") return rawValue.trim();
  if (typeof rawValue === "number" && Number.isFinite(rawValue)) return String(rawValue);

  const numberValue = rawObject.number;
  if (typeof numberValue === "number" && Number.isFinite(numberValue)) return String(numberValue);

  const nameValue = rawObject.name;
  if (typeof nameValue === "string") return nameValue.trim();
  if (nameValue && typeof nameValue === "object" && !Array.isArray(nameValue)) {
    const nestedRaw = (nameValue as Record<string, unknown>).raw;
    if (typeof nestedRaw === "string") return nestedRaw.trim();
  }

  const titleValue = rawObject.title;
  if (typeof titleValue === "string") return titleValue.trim();
  if (titleValue && typeof titleValue === "object" && !Array.isArray(titleValue)) {
    const nestedRaw = (titleValue as Record<string, unknown>).raw;
    if (typeof nestedRaw === "string") return nestedRaw.trim();
  }

  return "";
}

function parseGitHubIssueReference(value: string): {
  owner: string;
  repo: string;
  issueNumber: number;
  apiEndpoint: string;
  apiUrl: string;
  htmlUrl: string;
} | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const apiMatched =
    /^https:\/\/api\.github\.com\/repos\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)(?:[/?#].*)?$/i.exec(
      trimmed
    );
  if (apiMatched) {
    const owner = apiMatched[1] || "";
    const repo = apiMatched[2] || "";
    const issueNumber = Number(apiMatched[3] || 0);
    if (!owner || !repo || issueNumber <= 0) {
      return null;
    }
    return {
      owner,
      repo,
      issueNumber,
      apiEndpoint: `repos/${owner}/${repo}/issues/${issueNumber}`,
      apiUrl: `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`,
      htmlUrl: `https://github.com/${owner}/${repo}/issues/${issueNumber}`,
    };
  }

  const htmlMatched =
    /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)(?:[/?#].*)?$/i.exec(trimmed);
  if (!htmlMatched) {
    return null;
  }
  const owner = htmlMatched[1] || "";
  const repo = htmlMatched[2] || "";
  const issueNumber = Number(htmlMatched[3] || 0);
  if (!owner || !repo || issueNumber <= 0) {
    return null;
  }
  return {
    owner,
    repo,
    issueNumber,
    apiEndpoint: `repos/${owner}/${repo}/issues/${issueNumber}`,
    apiUrl: `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`,
    htmlUrl: `https://github.com/${owner}/${repo}/issues/${issueNumber}`,
  };
}

function parseIssueReferencePayload(
  payload: unknown,
  issueUrl: string,
  fallback: ReturnType<typeof parseGitHubIssueReference>
): ProjectIssueReference {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`issue lookup failed for ${issueUrl}: non-object payload`);
  }
  const record = payload as RestIssuePayload;
  const restId = normalizePositiveInteger(record.id);
  const nodeId = normalizeText(record.node_id);
  const issueNumber = normalizePositiveInteger(record.number) || fallback?.issueNumber || 0;
  const apiUrl = normalizeText(record.url) || fallback?.apiUrl || "";
  const htmlUrl = normalizeText(record.html_url) || fallback?.htmlUrl || "";
  const title = normalizeText(record.title);
  if (!restId || !nodeId || issueNumber <= 0 || !apiUrl || !htmlUrl) {
    throw new Error(
      `issue lookup failed for ${issueUrl}: response is missing canonical issue metadata`
    );
  }
  return { restId, nodeId, issueNumber, apiUrl, htmlUrl, title };
}

function resolveIssueReference(
  issueUrl: string,
  cwd: string | undefined,
  runGhJson: GhJsonRunner
): ProjectIssueReference {
  const parsed = parseGitHubIssueReference(issueUrl);
  if (!parsed) {
    throw new Error(`project issue reference must be a GitHub issue URL: ${issueUrl}`);
  }
  const payload = runGhJson(parsed.apiEndpoint, cwd);
  return parseIssueReferencePayload(payload, issueUrl, parsed);
}

function toObjectArray<T extends object>(payload: unknown): T[] {
  if (!Array.isArray(payload)) return [];
  return payload.filter(
    (entry): entry is T => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry)
  );
}

export function normalizeProjectFieldName(value: string): string {
  return value.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

export function pickProjectField(
  fields: Record<string, string>,
  aliases: readonly string[]
): string {
  for (const alias of aliases) {
    const key = normalizeProjectFieldName(alias);
    const value = (fields[key] ?? "").trim();
    if (value) return value;
  }
  return "";
}

export function parseProjectRoutePayload(
  payload: unknown,
  options: { owner: string; projectNumber: number; apiRoute: string }
): ProjectRoute {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("project route response must be an object");
  }
  const item = payload as RestProjectPayload;
  const restId = normalizePositiveInteger(item.id);
  const nodeId = normalizeText(item.node_id);
  const number = normalizePositiveInteger(item.number);
  const title = normalizeText(item.title);
  if (!restId || !nodeId || !number) {
    throw new Error("project route response is missing required ids");
  }
  if (number !== options.projectNumber) {
    throw new Error(
      `project route response number mismatch: expected ${options.projectNumber}, got ${number}`
    );
  }
  return {
    owner: options.owner,
    projectNumber: number,
    apiRoute: options.apiRoute,
    restId,
    nodeId,
    title,
  };
}

function parseProjectFieldOption(option: unknown): ProjectFieldOption | null {
  if (!option || typeof option !== "object" || Array.isArray(option)) return null;
  const record = option as Record<string, unknown>;
  const id = normalizeText(record.id);
  const name = parseRestFieldValue(record.name);
  if (!id || !name) return null;
  return { id, name };
}

export function parseProjectFieldCatalogPayload(
  project: ProjectRoute,
  payload: unknown
): ProjectFieldCatalog {
  const pages = Array.isArray(payload) ? payload : [];
  const rawFields = pages.some(Array.isArray)
    ? pages.flatMap((page) => toObjectArray<RestProjectFieldPayload>(page))
    : toObjectArray<RestProjectFieldPayload>(payload);
  const fields = rawFields
    .map((field): ProjectFieldDefinition | null => {
      const restId = normalizePositiveInteger(field.id);
      const nodeId = normalizeText(field.node_id);
      const name = normalizeText(field.name);
      const dataType = normalizeText(field.data_type).toUpperCase();
      if (!restId || !nodeId || !name) return null;
      const options = toObjectArray<Record<string, unknown>>(field.options)
        .map((entry) => parseProjectFieldOption(entry))
        .filter((entry): entry is ProjectFieldOption => Boolean(entry));
      return {
        restId,
        nodeId,
        name,
        dataType: dataType || "TEXT",
        options,
      };
    })
    .filter((field): field is ProjectFieldDefinition => Boolean(field));

  if (fields.length === 0) {
    throw new Error("project field lookup failed: no fields available on project");
  }

  const byName = new Map<string, ProjectFieldDefinition>();
  for (const field of fields) {
    byName.set(normalizeProjectFieldName(field.name), field);
  }

  return {
    project,
    fields,
    byName,
  };
}

export function findProjectFieldDefinition(
  catalog: ProjectFieldCatalog,
  aliases: readonly string[]
): ProjectFieldDefinition | null {
  for (const alias of aliases) {
    const field = catalog.byName.get(normalizeProjectFieldName(alias));
    if (field) return field;
  }
  return null;
}

function parseProjectItemRecord(raw: RestProjectItemPayload): ProjectItem | null {
  const restId = normalizePositiveInteger(raw.id);
  const nodeId = normalizeText(raw.node_id);
  const content =
    raw.content && typeof raw.content === "object" && !Array.isArray(raw.content)
      ? (raw.content as Record<string, unknown>)
      : {};
  const contentType = normalizeText(raw.content_type || content.type);
  const issueNumber = normalizePositiveInteger(content.number);
  const issueUrl = normalizeText(content.url);
  const htmlUrl = normalizeText(content.html_url);
  const title = normalizeText(content.title || raw.title);
  const fieldEntries = toObjectArray<RestProjectItemField>(raw.fields);
  if (!restId || !nodeId) return null;

  const fields: Record<string, string> = {};
  for (const field of fieldEntries) {
    const fieldName = normalizeProjectFieldName(normalizeText(field.name));
    if (!fieldName || fieldName === "title" || fields[fieldName] !== undefined) continue;
    const fieldValue = parseRestFieldValue(field.value);
    if (!fieldValue) continue;
    fields[fieldName] = fieldValue;
  }

  return {
    restId,
    nodeId,
    issueNumber,
    issueUrl,
    htmlUrl,
    contentType,
    title,
    fields,
  };
}

export function parseProjectItemsPayload(payload: unknown): ProjectItem[] {
  const pages = Array.isArray(payload) ? payload : [];
  const rawItems = pages.flatMap((page) => toObjectArray<RestProjectItemPayload>(page));
  return rawItems
    .map((raw) => parseProjectItemRecord(raw))
    .filter((item): item is ProjectItem => Boolean(item));
}

export function buildProjectFieldMap(
  catalog: ProjectFieldCatalog,
  items: ProjectItem[]
): ProjectFieldMapResult {
  const byIssueNumber = new Map<number, ProjectItem>();
  for (const item of items) {
    if (item.issueNumber > 0) {
      byIssueNumber.set(item.issueNumber, item);
    }
  }
  return {
    project: catalog.project,
    catalog,
    byIssueNumber,
    items,
  };
}

export function findProjectItemByIssueUrl(
  items: ProjectItem[],
  issueUrl: string
): ProjectItem | null {
  const issue = parseGitHubIssueReference(issueUrl);
  if (!issue) return null;
  return (
    items.find((item) => {
      if (item.issueNumber > 0 && item.issueNumber === issue.issueNumber) {
        return true;
      }
      return (
        item.issueUrl.trim().toLowerCase() === issue.apiUrl.toLowerCase() ||
        item.htmlUrl.trim().toLowerCase() === issue.htmlUrl.toLowerCase()
      );
    }) ?? null
  );
}

export function resolveProjectRoute(
  options: { owner: string; projectNumber: number; cwd?: string },
  runGhJson: GhJsonRunner = defaultRunGhJson
): ProjectRoute {
  const base = `projectsV2/${options.projectNumber}`;
  const candidates = [`orgs/${options.owner}/${base}`, `users/${options.owner}/${base}`];

  for (const route of candidates) {
    try {
      const payload = runGhJson(route, options.cwd);
      return parseProjectRoutePayload(payload, {
        owner: options.owner,
        projectNumber: options.projectNumber,
        apiRoute: route,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes("not found") || /\b404\b/.test(message)) {
        continue;
      }
      throw error;
    }
  }

  throw new Error(
    `project ${options.projectNumber} for owner ${options.owner} was not found via org/user REST routes`
  );
}

export function fetchProjectFieldCatalog(
  options: { owner: string; projectNumber: number; cwd?: string; project?: ProjectRoute },
  runGhJson: GhJsonRunner = defaultRunGhJson,
  runGhPaginated: GhJsonRunner = defaultRunGhPaginated
): ProjectFieldCatalog {
  const project =
    options.project ??
    resolveProjectRoute(
      { owner: options.owner, projectNumber: options.projectNumber, cwd: options.cwd },
      runGhJson
    );
  const payload = runGhPaginated(`${project.apiRoute}/fields?per_page=100`, options.cwd);
  return parseProjectFieldCatalogPayload(project, payload);
}

export function listProjectItems(
  options: {
    owner: string;
    projectNumber: number;
    limit?: number;
    fieldNames?: string[];
    cwd?: string;
    project?: ProjectRoute;
    catalog?: ProjectFieldCatalog;
  },
  runGhJson: GhJsonRunner = defaultRunGhJson,
  runGhPaginated: GhJsonRunner = defaultRunGhPaginated
): ProjectItem[] {
  const catalog =
    options.catalog ??
    fetchProjectFieldCatalog(
      {
        owner: options.owner,
        projectNumber: options.projectNumber,
        cwd: options.cwd,
        project: options.project,
      },
      runGhJson,
      runGhPaginated
    );
  const requestedFieldNames = (options.fieldNames || []).map((fieldName) =>
    normalizeProjectFieldName(fieldName)
  );
  const selectedFields =
    requestedFieldNames.length > 0
      ? catalog.fields.filter((field) =>
          requestedFieldNames.includes(normalizeProjectFieldName(field.name))
        )
      : catalog.fields;

  const mergeKey = (item: ProjectItem): string =>
    item.issueNumber > 0 ? `issue:${item.issueNumber}` : `item:${item.restId}:${item.nodeId}`;
  const mergedItems = new Map<string, ProjectItem>();
  const fieldChunks =
    selectedFields.length > 0
      ? Array.from(
          { length: Math.ceil(selectedFields.length / PROJECT_ITEMS_FIELD_CHUNK_SIZE) },
          (_, index) =>
            selectedFields.slice(
              index * PROJECT_ITEMS_FIELD_CHUNK_SIZE,
              (index + 1) * PROJECT_ITEMS_FIELD_CHUNK_SIZE
            )
        )
      : [[]];

  for (const fieldChunk of fieldChunks) {
    const fieldIds = fieldChunk.map((field) => `fields[]=${field.restId}`);
    const endpoint = `${catalog.project.apiRoute}/items?per_page=${PROJECT_ITEMS_PAGE_SIZE}${
      fieldIds.length > 0 ? `&${fieldIds.join("&")}` : ""
    }`;
    const payload = runGhPaginated(endpoint, options.cwd);
    const items = parseProjectItemsPayload(payload);
    for (const item of items) {
      const key = mergeKey(item);
      const existing = mergedItems.get(key);
      if (!existing) {
        mergedItems.set(key, item);
        continue;
      }
      mergedItems.set(key, {
        ...existing,
        fields: {
          ...existing.fields,
          ...item.fields,
        },
      });
    }
  }

  const items = [...mergedItems.values()].map((item) => {
    if (requestedFieldNames.length === 0) {
      return item;
    }

    const filteredFields = Object.fromEntries(
      Object.entries(item.fields).filter(([fieldName]) => requestedFieldNames.includes(fieldName))
    );
    return {
      ...item,
      fields: filteredFields,
    };
  });
  if (typeof options.limit === "number" && Number.isFinite(options.limit)) {
    return items.slice(0, Math.max(0, Math.trunc(options.limit)));
  }
  return items;
}

export function fetchProjectFieldMap(
  options: {
    owner: string;
    projectNumber: number;
    limit?: number;
    fieldNames?: string[];
    cwd?: string;
  },
  runGhJson: GhJsonRunner = defaultRunGhJson,
  runGhPaginated: GhJsonRunner = defaultRunGhPaginated
): ProjectFieldMapResult {
  const catalog = fetchProjectFieldCatalog(options, runGhJson, runGhPaginated);
  const items = listProjectItems(
    {
      ...options,
      project: catalog.project,
      catalog,
    },
    runGhJson,
    runGhPaginated
  );
  return buildProjectFieldMap(catalog, items);
}

export function addProjectTextField(
  options: {
    project: Pick<
      ProjectRoute,
      "owner" | "projectNumber" | "apiRoute" | "restId" | "nodeId" | "title"
    >;
    name: string;
    cwd?: string;
  },
  dependencies?: { runGhCommand?: GhCommandRunner }
): ProjectFieldDefinition {
  const fieldName = normalizeText(options.name);
  if (!fieldName) {
    throw new Error("project field name is required");
  }
  const endpoint = `${options.project.apiRoute}/fields`;
  const runGhCommand = dependencies?.runGhCommand ?? defaultRunGhCommand;
  const result = runGhCommand(
    ["api", endpoint, "--method", "POST", "--input", "-"],
    options.cwd,
    `${JSON.stringify({ name: fieldName, data_type: "text" })}\n`
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `gh api ${endpoint} failed: ${formatSpawnFailure(result, GH_API_MAX_BUFFER_BYTES)}`
    );
  }
  return parseProjectFieldCatalogPayload(
    {
      owner: options.project.owner,
      projectNumber: options.project.projectNumber,
      apiRoute: options.project.apiRoute,
      restId: options.project.restId,
      nodeId: options.project.nodeId,
      title: options.project.title,
    },
    [JSON.parse(result.stdout || "{}")]
  ).fields[0] as ProjectFieldDefinition;
}

export function deleteProjectItem(
  options: {
    project: Pick<
      ProjectRoute,
      "owner" | "projectNumber" | "apiRoute" | "restId" | "nodeId" | "title"
    >;
    item: ProjectItemIdentity;
    cwd?: string;
  },
  dependencies?: { runGhCommand?: GhCommandRunner }
): void {
  const endpoint = `${options.project.apiRoute}/items/${options.item.restId}`;
  const runGhCommand = dependencies?.runGhCommand ?? defaultRunGhCommand;
  const result = runGhCommand(["api", endpoint, "--method", "DELETE"], options.cwd);
  if (result.error || result.status !== 0) {
    throw new Error(
      `gh api ${endpoint} failed: ${formatSpawnFailure(result, GH_API_MAX_BUFFER_BYTES)}`
    );
  }
}

function parseProjectItemEnvelopePayload(payload: unknown, context: string): ProjectItem {
  const item = unwrapProjectItemPayloadValue(payload, context) as RestProjectItemPayload;
  const parsed = parseProjectItemRecord(item);
  if (!parsed) {
    throw new Error(`${context} response is missing canonical project item metadata`);
  }
  return parsed;
}

function isProjectItemAlreadyAttachedResult(result: ProjectCommandResult): boolean {
  if (result.status === 0) {
    return false;
  }
  const detail = `${result.stderr || ""}\n${result.stdout || ""}`.toLowerCase();
  return (
    detail.includes("content already exists in this project") ||
    detail.includes("already exists in this project")
  );
}

function parseGhApiIncludedResponse(text: string): { headers: string; body: string } {
  const normalized = text.replace(/\r\n/g, "\n");
  const separator = normalized.indexOf("\n\n");
  if (separator < 0) {
    return { headers: "", body: normalized.trim() };
  }
  return {
    headers: normalized.slice(0, separator).trim(),
    body: normalized.slice(separator + 2).trim(),
  };
}

function nextProjectItemsEndpoint(headers: string): string {
  const linkHeader =
    headers
      .split("\n")
      .find((line) => line.toLowerCase().startsWith("link:"))
      ?.slice(5)
      .trim() || "";
  if (!linkHeader) {
    return "";
  }
  for (const segment of linkHeader.split(",")) {
    const matched = /<([^>]+)>\s*;\s*rel="next"/i.exec(segment.trim());
    if (matched?.[1]) {
      const nextUrl = matched[1].trim();
      if (/^https:\/\/api\.github\.com\//i.test(nextUrl)) {
        return nextUrl.replace(/^https:\/\/api\.github\.com\//i, "");
      }
      return nextUrl;
    }
  }
  return "";
}

function resolveProjectItemByIssueReference(
  options: {
    project: ProjectRoute;
    issue: ProjectIssueReference;
    cwd?: string;
  },
  runGhCommand: GhCommandRunner = defaultRunGhCommand
): ProjectItem | null {
  let endpoint = `${options.project.apiRoute}/items?per_page=${PROJECT_ITEMS_PAGE_SIZE}`;
  while (endpoint) {
    const result = runGhCommand(["api", "-i", endpoint], options.cwd);
    if (result.error || result.status !== 0) {
      throw new Error(
        `gh api ${endpoint} failed: ${formatSpawnFailure(result, GH_API_MAX_BUFFER_BYTES)}`
      );
    }
    const { headers, body } = parseGhApiIncludedResponse(result.stdout || "");
    const payload = body ? (JSON.parse(body) as unknown) : [];
    if (!Array.isArray(payload)) {
      throw new Error(`gh api ${endpoint} returned non-array item page payload`);
    }
    const resolved = findProjectItemByIssueUrl(
      parseProjectItemsPayload([payload]),
      options.issue.htmlUrl
    );
    if (resolved) {
      return resolved;
    }
    endpoint = nextProjectItemsEndpoint(headers);
  }
  return null;
}

export function ensureProjectItemAttached(
  options: {
    owner: string;
    projectNumber: number;
    issueUrl: string;
    cwd?: string;
    project?: ProjectRoute;
  },
  dependencies?: {
    runGhJson?: GhJsonRunner;
    runGhCommand?: GhCommandRunner;
  }
): ProjectAttachResult {
  const runGhJson = dependencies?.runGhJson ?? defaultRunGhJson;
  const runGhCommand = dependencies?.runGhCommand ?? defaultRunGhCommand;
  const project =
    options.project ??
    resolveProjectRoute(
      { owner: options.owner, projectNumber: options.projectNumber, cwd: options.cwd },
      runGhJson
    );
  const issue = resolveIssueReference(options.issueUrl, options.cwd, runGhJson);

  const add = runGhCommand(
    ["api", `${project.apiRoute}/items`, "--method", "POST", "--input", "-"],
    options.cwd,
    `${JSON.stringify({ type: "Issue", id: issue.restId })}\n`
  );
  if (add.status === 0) {
    const item = parseProjectItemEnvelopePayload(
      JSON.parse(add.stdout || "{}"),
      "project item attach"
    );
    const matchesIssue =
      item.issueNumber === issue.issueNumber ||
      item.issueUrl.trim().toLowerCase() === issue.apiUrl.toLowerCase() ||
      item.htmlUrl.trim().toLowerCase() === issue.htmlUrl.toLowerCase();
    if (!matchesIssue) {
      throw new Error(
        `project item attach returned mismatched issue reference: expected #${issue.issueNumber}, got #${item.issueNumber || 0}`
      );
    }
    return {
      project,
      item,
      attached: true,
    };
  }

  if (!isProjectItemAlreadyAttachedResult(add)) {
    throw new Error(
      `gh api ${project.apiRoute}/items failed: ${formatSpawnFailure(add, GH_API_MAX_BUFFER_BYTES)}`
    );
  }

  let resolved: ProjectItem | null = null;
  for (const delayMs of PROJECT_ITEM_RESOLVE_RETRY_DELAYS_MS) {
    sleepSync(delayMs);
    resolved = resolveProjectItemByIssueReference(
      {
        project,
        issue,
        cwd: options.cwd,
      },
      runGhCommand
    );
    if (resolved) {
      break;
    }
  }
  if (!resolved) {
    throw new Error(`failed to resolve project item for ${issue.htmlUrl}`);
  }

  return {
    project,
    item: resolved,
    attached: false,
  };
}

function parseBatchProjectFieldUpdateCliPayload(text: string): BatchProjectFieldUpdateCliPayload {
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`invalid JSON payload: ${(error as Error).message}`);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("batch update payload must be an object");
  }
  const record = payload as Record<string, unknown>;
  const project =
    record.project && typeof record.project === "object" && !Array.isArray(record.project)
      ? (record.project as BatchProjectFieldUpdateCliPayload["project"])
      : null;
  const item =
    record.item && typeof record.item === "object" && !Array.isArray(record.item)
      ? (record.item as ProjectItemIdentity)
      : null;
  const updates = Array.isArray(record.updates)
    ? (record.updates as ProjectFieldValueUpdate[])
    : null;
  const cwd = normalizeText(record.cwd);
  if (!project || !item || !updates) {
    throw new Error("batch update payload must include project, item, and updates");
  }
  return { project, item, updates, cwd };
}

function readCliFlag(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  if (index < 0) return "";
  return String(args[index + 1] || "");
}

function main(argv: string[]): void {
  const [command, ...args] = argv;
  if (command !== "update-item-fields") {
    throw new Error("unsupported command");
  }
  const payloadJson = readCliFlag(args, "--payload-json").trim();
  if (!payloadJson) {
    throw new Error("--payload-json is required");
  }
  const payload = parseBatchProjectFieldUpdateCliPayload(payloadJson);
  updateProjectItemFields(payload);
  process.stdout.write(
    `${JSON.stringify({ ok: true, item: payload.item, updates: payload.updates.length })}\n`
  );
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`github-project-fields failed: ${(error as Error).message}\n`);
    process.exit(1);
  }
}
