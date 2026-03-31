#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { enrollIssuesToProject, resolveProjectContext } from "./project_enroll";

type JsonObject = Record<string, unknown>;

type Command = "build" | "validate";

type ParsedCli = {
  command: Command;
  repository: string;
  source: string;
  output: string;
  baseBranch: string;
  maxWorkers: string;
};

function usage(): string {
  return [
    "Usage:",
    "  bun register_runtime.ts build --repository <owner/repo> [--source <issues.json>] [--output <path>] [--base-branch <name>] [--max-workers <n>]",
    "  bun register_runtime.ts validate --repository <owner/repo> [--source <issues.json>] [--base-branch <name>] [--max-workers <n>]",
    "",
    "Examples:",
    "  bun register_runtime.ts build --repository owner/repo --output .tmp/execution-plan.json",
    "  bun register_runtime.ts build --repository owner/repo --source ./.tmp/issues.json --output .tmp/execution-plan.json",
    "  bun register_runtime.ts validate --repository owner/repo --source ./.tmp/issues.json",
    "",
    "Validation contract:",
    "  - nodes[].github_issue is required and must be unique across nodes",
    "  - nodes[].covers must contain exactly one source id",
    "  - source_items[].parent_issue_number / parent_issue_url are optional, but when one is set both must be valid",
    "  - issue_map source IDs must not share the same issue URL",
    "  - nodes[].github_issue must match issue_map for covered source IDs",
  ].join("\n");
}

function fail(message: string): never {
  throw new Error(message);
}

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const detail = `${result.stderr || ""}\n${result.stdout || ""}`.trim();
    fail(`${command} ${args.join(" ")} failed: ${detail || `exit=${result.status}`}`);
  }
  return String(result.stdout || "").trim();
}

function parseCli(argv: string[]): ParsedCli {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }

  const commandRaw = argv[0]?.trim() || "";
  if (commandRaw !== "build" && commandRaw !== "validate") {
    fail(`unknown command: ${commandRaw}`);
  }

  const flags = new Map<string, string>();
  const allowedFlags = new Set(["repository", "source", "output", "base-branch", "max-workers"]);
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i] ?? "";
    if (!token.startsWith("--")) {
      fail(`unexpected positional argument: ${token}`);
    }
    const key = token.slice(2);
    if (!allowedFlags.has(key)) {
      fail(`unknown option: --${key}`);
    }
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      fail(`--${key} requires a value`);
    }
    flags.set(key, value);
    i += 1;
  }

  const repository = (flags.get("repository") || "").trim();
  const parsedRepository = parseRepositorySlug(repository);
  if (!parsedRepository) {
    fail("--repository is required and must be <owner>/<repo>");
  }

  return {
    command: commandRaw,
    repository: `${parsedRepository.owner}/${parsedRepository.repo}`,
    source: (flags.get("source") || "").trim(),
    output: (flags.get("output") || "").trim(),
    baseBranch: (flags.get("base-branch") || "").trim(),
    maxWorkers: (flags.get("max-workers") || "").trim(),
  };
}

function resolveRepoRoot(): string {
  const stdout = run("git", ["rev-parse", "--show-toplevel"], process.cwd());
  const root = stdout.trim();
  if (!root) fail("failed to resolve repository root");
  return root;
}

function runExecutionPlanExport(
  repoRoot: string,
  options: {
    repository: string;
    source: string;
    outputPath: string;
    baseBranch: string;
    maxWorkers: string;
  }
): void {
  const args = [
    "run",
    "execution-plan:from-issues",
    "--",
    "--repository",
    options.repository,
    "--output",
    options.outputPath,
  ];
  if (options.source) {
    args.push("--source", path.resolve(repoRoot, options.source));
  }
  if (options.baseBranch) {
    args.push("--base-branch", options.baseBranch);
  }
  if (options.maxWorkers) {
    args.push("--max-workers", options.maxWorkers);
  }
  run("bun", args, repoRoot);
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const SOURCE_VERDICTS = new Set(["valid", "already-fixed", "invalid", "pending"]);

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseRepositorySlug(value: string): { owner: string; repo: string } | null {
  const parts = value
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length !== 2) return null;
  return { owner: parts[0], repo: parts[1] };
}

export function validateHandoff(payload: unknown): string[] {
  const errors: string[] = [];
  if (!isObject(payload)) {
    return ["handoff payload must be a JSON object"];
  }

  let repositorySlug = "";
  const issueTracking = payload.issue_tracking;
  if (!isObject(issueTracking)) {
    errors.push("missing issue_tracking object");
  } else {
    const strategy = String(issueTracking.strategy || "").trim();
    const repository = String(issueTracking.repository || "").trim();
    const progressIssueNumberRaw = Number(issueTracking.progress_issue_number || 0);
    const progressIssueUrl = String(issueTracking.progress_issue_url || "").trim();
    if (strategy !== "remote-github-sot") {
      errors.push("issue_tracking.strategy must be remote-github-sot");
    }
    if (!repository || !/^[^/]+\/[^/]+$/.test(repository)) {
      errors.push("issue_tracking.repository must be <owner>/<repo>");
    } else {
      repositorySlug = repository;
    }
    if (!Number.isInteger(progressIssueNumberRaw) || progressIssueNumberRaw < 0) {
      errors.push("issue_tracking.progress_issue_number must be a non-negative integer");
    }
    if (progressIssueUrl) {
      const matched = progressIssueUrl.match(
        /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)$/i
      );
      if (!matched) {
        errors.push(
          "issue_tracking.progress_issue_url must be https://github.com/<owner>/<repo>/issues/<number>"
        );
      } else if (
        Number.isInteger(progressIssueNumberRaw) &&
        progressIssueNumberRaw > 0 &&
        Number(matched[3]) !== progressIssueNumberRaw
      ) {
        errors.push(
          `issue_tracking.progress_issue_url issue number must match progress_issue_number (${progressIssueNumberRaw})`
        );
      }
    }
  }

  const issueMapById = new Map<string, string>();
  const sourceIdByIssueUrl = new Map<string, string>();
  const issueMap = payload.issue_map;
  if (!isObject(issueMap)) {
    errors.push("missing issue_map object");
  } else if (Object.keys(issueMap).length === 0) {
    errors.push("issue_map must not be empty");
  } else {
    for (const [key, value] of Object.entries(issueMap)) {
      const sourceId = key.trim();
      const issueUrl = String(value || "").trim();
      if (!sourceId) {
        errors.push("issue_map keys must not be empty");
        continue;
      }
      if (!issueUrl) {
        errors.push(`issue_map.${sourceId} must be a non-empty issue URL`);
        continue;
      }
      issueMapById.set(sourceId, issueUrl);
      const normalizedIssueUrl = issueUrl.toLowerCase();
      const duplicateSource = sourceIdByIssueUrl.get(normalizedIssueUrl);
      if (duplicateSource && duplicateSource !== sourceId) {
        errors.push(
          `issue_map must not map multiple source ids to the same issue URL: ${duplicateSource}, ${sourceId} -> ${issueUrl}`
        );
      } else {
        sourceIdByIssueUrl.set(normalizedIssueUrl, sourceId);
      }
    }
  }

  const sourceVerdictById = new Map<string, string>();
  const sourceParentIssueById = new Map<string, { number: number; url: string }>();
  const sourceItems = payload.source_items;
  if (!Array.isArray(sourceItems) || sourceItems.length === 0) {
    errors.push("missing source_items array");
  } else {
    for (const [index, item] of sourceItems.entries()) {
      if (!isObject(item)) {
        errors.push(`source_items[${index}] must be an object`);
        continue;
      }
      const id = String(item.id || "").trim();
      const verdict = String(item.verdict || "")
        .trim()
        .toLowerCase();
      const hasParentIssueNumberField = Object.hasOwn(item, "parent_issue_number");
      const hasParentIssueUrlField = Object.hasOwn(item, "parent_issue_url");
      const parentIssueNumber = Number(item.parent_issue_number ?? 0);
      const parentIssueUrl = String((item.parent_issue_url ?? "") || "").trim();
      if (!id) {
        errors.push(`source_items[${index}].id is required`);
        continue;
      }
      if (sourceVerdictById.has(id)) {
        errors.push(`source_items id must be unique: ${id}`);
      }
      if (!SOURCE_VERDICTS.has(verdict)) {
        errors.push(
          `source_items[${index}] verdict must be one of valid|already-fixed|invalid|pending`
        );
        continue;
      }

      if (hasParentIssueNumberField !== hasParentIssueUrlField) {
        errors.push(
          `source_items[${index}] must set parent_issue_number and parent_issue_url together`
        );
      }
      if (
        hasParentIssueNumberField &&
        (!Number.isInteger(parentIssueNumber) || parentIssueNumber <= 0)
      ) {
        errors.push(`source_items[${index}].parent_issue_number must be a positive integer`);
      }
      if (hasParentIssueUrlField && !parentIssueUrl) {
        errors.push(`source_items[${index}].parent_issue_url is required`);
      }
      if (hasParentIssueUrlField && parentIssueUrl) {
        const matched = parentIssueUrl.match(
          /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)$/i
        );
        if (!matched) {
          errors.push(
            `source_items[${index}].parent_issue_url must be https://github.com/<owner>/<repo>/issues/<number>`
          );
        } else if (
          hasParentIssueNumberField &&
          Number.isInteger(parentIssueNumber) &&
          parentIssueNumber > 0 &&
          Number(matched[3]) !== parentIssueNumber
        ) {
          errors.push(
            `source_items[${index}].parent_issue_url issue number must match parent_issue_number (${parentIssueNumber})`
          );
        }
      }

      sourceVerdictById.set(id, verdict);
      if (
        hasParentIssueNumberField &&
        hasParentIssueUrlField &&
        Number.isInteger(parentIssueNumber) &&
        parentIssueNumber > 0 &&
        parentIssueUrl
      ) {
        sourceParentIssueById.set(id, {
          number: parentIssueNumber,
          url: parentIssueUrl,
        });
      }
    }
  }

  const nodeIdSet = new Set<string>();
  const nodeIdByIssueUrl = new Map<string, string>();
  const nodeIssueById = new Map<string, string>();
  const sourceCoverCount = new Map<string, number>();
  const nodes = payload.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) {
    errors.push("nodes must be a non-empty array");
  } else {
    for (const node of nodes) {
      if (!isObject(node)) {
        errors.push("nodes[] must be objects");
        continue;
      }
      const id = String(node.id || "").trim();
      const branch = String(node.branch || "").trim();
      const allowedFiles = node.allowed_files;
      const acceptanceChecks = node.acceptance_checks;
      const tests = node.tests;
      const covers = node.covers;
      const githubIssue = String(node.github_issue || "").trim();
      if (!id) errors.push("nodes[].id is required");
      if (id && nodeIdSet.has(id)) {
        errors.push(`nodes[].id must be unique: ${id}`);
      }
      if (id) {
        nodeIdSet.add(id);
      }
      if (!branch) errors.push(`node ${id || "<unknown>"}: branch is required`);
      if (!Array.isArray(allowedFiles) || allowedFiles.length === 0) {
        errors.push(`node ${id || "<unknown>"}: allowed_files is required`);
      }
      if (!Array.isArray(acceptanceChecks) || acceptanceChecks.length === 0) {
        errors.push(`node ${id || "<unknown>"}: acceptance_checks is required`);
      }
      if (!Array.isArray(tests) || tests.length === 0) {
        errors.push(`node ${id || "<unknown>"}: tests is required`);
      }
      if (!githubIssue) {
        errors.push(`node ${id || "<unknown>"}: github_issue is required`);
      } else {
        const normalizedIssueUrl = githubIssue.toLowerCase();
        const duplicateNodeId = nodeIdByIssueUrl.get(normalizedIssueUrl);
        if (duplicateNodeId && duplicateNodeId !== id) {
          errors.push(
            `nodes must not share github_issue URL: ${duplicateNodeId} and ${id || "<unknown>"} -> ${githubIssue}`
          );
        } else if (id) {
          nodeIdByIssueUrl.set(normalizedIssueUrl, id);
          nodeIssueById.set(id, githubIssue);
        }
      }
      if (!Array.isArray(covers) || covers.length === 0) {
        errors.push(`node ${id || "<unknown>"}: covers is required`);
      } else {
        if (covers.length !== 1) {
          errors.push(`node ${id || "<unknown>"}: covers must contain exactly one source id`);
        }
        const localSeen = new Set<string>();
        for (const rawCoverId of covers) {
          const coverId = String(rawCoverId || "").trim();
          if (!coverId) {
            errors.push(`node ${id || "<unknown>"}: covers[] must be non-empty strings`);
            continue;
          }
          if (localSeen.has(coverId)) {
            errors.push(`node ${id || "<unknown>"}: duplicate covers id ${coverId}`);
            continue;
          }
          localSeen.add(coverId);
          if (!sourceVerdictById.has(coverId)) {
            errors.push(
              `node ${id || "<unknown>"}: covers references unknown source id ${coverId}`
            );
            continue;
          }
          const mappedIssueUrl = issueMapById.get(coverId);
          if (
            mappedIssueUrl &&
            githubIssue &&
            mappedIssueUrl.toLowerCase() !== githubIssue.toLowerCase()
          ) {
            errors.push(
              `node ${id || "<unknown>"}: github_issue must match issue_map.${coverId} (${mappedIssueUrl})`
            );
          }
          sourceCoverCount.set(coverId, (sourceCoverCount.get(coverId) || 0) + 1);
        }
      }
    }
  }

  for (const sourceId of sourceVerdictById.keys()) {
    if (!issueMapById.has(sourceId)) {
      errors.push(`issue_map is missing source id: ${sourceId}`);
    }
  }
  for (const issueMapId of issueMapById.keys()) {
    if (!sourceVerdictById.has(issueMapId)) {
      errors.push(`issue_map contains unknown source id: ${issueMapId}`);
    }
  }

  if (repositorySlug) {
    const repository = parseRepositorySlug(repositorySlug);
    if (repository) {
      const issuePattern = new RegExp(
        `^https://github\\.com/${escapeRegex(repository.owner)}/${escapeRegex(repository.repo)}/issues/\\d+$`,
        "i"
      );
      for (const [sourceId, issueUrl] of issueMapById.entries()) {
        if (!issuePattern.test(issueUrl)) {
          errors.push(
            `issue_map.${sourceId} must reference https://github.com/${repository.owner}/${repository.repo}/issues/<number>`
          );
        }
        const parentIssue = sourceParentIssueById.get(sourceId);
        if (parentIssue) {
          if (!issuePattern.test(parentIssue.url)) {
            errors.push(
              `source_items.${sourceId}.parent_issue_url must reference https://github.com/${repository.owner}/${repository.repo}/issues/<number>`
            );
          }
          if (parentIssue.url.toLowerCase() === issueUrl.toLowerCase()) {
            errors.push(
              `source_items.${sourceId}.parent_issue_url must not be the same as issue_map.${sourceId}`
            );
          }
        }
      }
      for (const [nodeId, issueUrl] of nodeIssueById.entries()) {
        if (!issuePattern.test(issueUrl)) {
          errors.push(
            `node ${nodeId}: github_issue must reference https://github.com/${repository.owner}/${repository.repo}/issues/<number>`
          );
        }
      }
      const progressIssueUrl = String(
        (payload.issue_tracking as Record<string, unknown>)?.progress_issue_url || ""
      ).trim();
      if (progressIssueUrl && !issuePattern.test(progressIssueUrl)) {
        errors.push(
          `issue_tracking.progress_issue_url must reference https://github.com/${repository.owner}/${repository.repo}/issues/<number>`
        );
      }
    }
  }

  for (const [sourceId, verdict] of sourceVerdictById.entries()) {
    const coverCount = sourceCoverCount.get(sourceId) || 0;
    if (verdict === "valid" && coverCount !== 1) {
      errors.push(`valid source item ${sourceId} must be covered by exactly one node`);
    }
    if (verdict !== "valid" && coverCount !== 0) {
      errors.push(`non-valid source item ${sourceId} must not be covered by nodes`);
    }
    if (coverCount > 1) {
      errors.push(`source item ${sourceId} is covered by multiple nodes`);
    }
  }

  return errors;
}

function readJson(filePath: string): unknown {
  const text = readFileSync(filePath, "utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    fail(`invalid JSON (${filePath}): ${(error as Error).message}`);
  }
}

function writeOutput(payload: unknown, outputPath: string): void {
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  if (outputPath) {
    const absolute = path.resolve(outputPath);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, text, "utf8");
    console.log(`handoff bundle written: ${absolute}`);
    return;
  }
  process.stdout.write(text);
}

function main(): void {
  const cli = parseCli(process.argv.slice(2));
  const repoRoot = resolveRepoRoot();

  const tempDir = mkdtempSync(path.join(os.tmpdir(), "ip-register-"));
  const tempOut = path.join(tempDir, "execution-plan.json");
  try {
    runExecutionPlanExport(repoRoot, {
      repository: cli.repository,
      source: cli.source,
      outputPath: tempOut,
      baseBranch: cli.baseBranch,
      maxWorkers: cli.maxWorkers,
    });

    const payload = readJson(tempOut);
    const errors = validateHandoff(payload);
    if (errors.length > 0) {
      fail(`handoff contract validation failed:\n- ${errors.join("\n- ")}`);
    }

    const parsed = payload as JsonObject;
    const projectContext = parsed.project_context;
    if (
      isObject(projectContext) &&
      String((projectContext as JsonObject).project_id || "").trim()
    ) {
      const projectId = String((projectContext as JsonObject).project_id).trim();
      const projectNumber = Number((projectContext as JsonObject).project_number || 0);
      const dagNodes = Array.isArray(parsed.nodes) ? parsed.nodes : [];
      const issueNodeIds = dagNodes
        .map((n) => (isObject(n) ? String((n as JsonObject).issue_node_id || "").trim() : ""))
        .filter(Boolean);

      if (issueNodeIds.length > 0) {
        enrollIssuesToProject(repoRoot, projectId, issueNodeIds);
        console.log(`enrolled ${issueNodeIds.length} issues to project`);
      }

      const resolved = resolveProjectContext(repoRoot, projectId, projectNumber);
      (parsed as Record<string, unknown>).project_context = resolved;
    }

    if (cli.command === "validate") {
      const nodes = Array.isArray(parsed.nodes) ? parsed.nodes.length : 0;
      const issueMap = isObject(parsed.issue_map) ? Object.keys(parsed.issue_map).length : 0;
      console.log(`register validation passed | nodes=${nodes} | issue_map=${issueMap}`);
      return;
    }

    writeOutput(parsed, cli.output);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(`register_runtime failed: ${(error as Error).message}`);
    process.exit(1);
  }
}
