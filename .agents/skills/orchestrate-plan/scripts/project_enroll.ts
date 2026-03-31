#!/usr/bin/env bun

import { execFileSync } from "node:child_process";

type FieldCatalogEntry = {
  id: string;
  name: string;
  data_type: string;
  options: Record<string, { id: string; name: string }>;
};

type FieldCatalog = Record<string, FieldCatalogEntry>;

export type ProjectContext = {
  project_id: string;
  project_number: number;
  field_catalog: FieldCatalog;
};

function normalizeFieldName(value: string): string {
  return value.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

function ghGraphql(repoRoot: string, query: string, variables: Record<string, unknown>): unknown {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    if (typeof value === "number") {
      args.push("-F", `${key}=${value}`);
    } else {
      args.push("-f", `${key}=${String(value)}`);
    }
  }
  const stdout = execFileSync("gh", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const parsed = JSON.parse(stdout) as { data?: unknown; errors?: Array<{ message?: string }> };
  if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
    const messages = parsed.errors.map((e) => String(e?.message || "unknown")).join(" | ");
    throw new Error(`GraphQL error: ${messages}`);
  }
  return parsed.data;
}

export function fetchFieldCatalog(repoRoot: string, projectId: string): FieldCatalog {
  const data = ghGraphql(
    repoRoot,
    `query($projectId: ID!) {
      node(id: $projectId) {
        ... on ProjectV2 {
          id
          number
          title
          fields(first: 100) {
            nodes {
              __typename
              ... on ProjectV2Field { id name dataType }
              ... on ProjectV2SingleSelectField {
                id name dataType
                options { id name }
              }
              ... on ProjectV2IterationField { id name dataType }
            }
          }
        }
      }
    }`,
    { projectId }
  ) as { node?: { fields?: { nodes?: Array<Record<string, unknown>> } } } | null;

  const fields = data?.node?.fields?.nodes ?? [];
  const catalog: FieldCatalog = {};

  for (const entry of fields) {
    if (!entry || typeof entry !== "object") continue;
    const fieldId = String(entry.id || "").trim();
    const fieldName = String(entry.name || "").trim();
    const dataType = String(entry.dataType || "")
      .trim()
      .toUpperCase();
    if (!fieldId || !fieldName) continue;
    const key = normalizeFieldName(fieldName);
    if (!key) continue;

    const optionMap: Record<string, { id: string; name: string }> = {};
    const rawOptions = entry.options as Array<{ id?: string; name?: string }> | undefined;
    if (Array.isArray(rawOptions)) {
      for (const opt of rawOptions) {
        const optId = String(opt?.id || "").trim();
        const optName = String(opt?.name || "").trim();
        if (!optId || !optName) continue;
        optionMap[normalizeFieldName(optName)] = { id: optId, name: optName };
      }
    }

    catalog[key] = {
      id: fieldId,
      name: fieldName,
      data_type: dataType || "TEXT",
      options: optionMap,
    };
  }

  if (Object.keys(catalog).length === 0) {
    throw new Error("field catalog is empty: no fields found on project");
  }

  return catalog;
}

export function enrollIssuesToProject(
  repoRoot: string,
  projectId: string,
  issueNodeIds: string[],
  batchSize = 20
): Map<string, string> {
  const results = new Map<string, string>();
  if (issueNodeIds.length === 0) return results;

  for (let offset = 0; offset < issueNodeIds.length; offset += batchSize) {
    const batch = issueNodeIds.slice(offset, offset + batchSize);
    const fragments: string[] = [];
    const vars: Record<string, unknown> = {};

    for (let i = 0; i < batch.length; i++) {
      const alias = `e${i}`;
      const varName = `contentId_${i}`;
      vars[varName] = batch[i];
      fragments.push(
        `${alias}: addProjectV2ItemById(input: {projectId: "${projectId}", contentId: $${varName}}) { item { id } }`
      );
    }

    const varDecls = Object.keys(vars)
      .map((k) => `$${k}: ID!`)
      .join(", ");
    const query = `mutation(${varDecls}) {\n  ${fragments.join("\n  ")}\n}`;

    const data = ghGraphql(repoRoot, query, vars) as Record<
      string,
      { item?: { id?: string } }
    > | null;
    if (data) {
      for (let i = 0; i < batch.length; i++) {
        const alias = `e${i}`;
        const itemId = String(data[alias]?.item?.id || "").trim();
        if (itemId) {
          results.set(batch[i], itemId);
        }
      }
    }
  }

  return results;
}

export function resolveProjectContext(
  repoRoot: string,
  projectId: string,
  projectNumber: number
): ProjectContext {
  const fieldCatalog = fetchFieldCatalog(repoRoot, projectId);
  return {
    project_id: projectId,
    project_number: projectNumber,
    field_catalog: fieldCatalog,
  };
}
