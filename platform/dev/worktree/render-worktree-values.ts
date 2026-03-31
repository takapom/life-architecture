#!/usr/bin/env bun

import { writeFileSync } from "node:fs";
import path from "node:path";

import { Command } from "commander";

import {
  resolveWorktreeBaseValues,
  resolveWorktreeRuntimePlan,
  resolveWorktreeRuntimeValues,
} from "./worktree-runtime-plan.ts";

type CliOptions = {
  mode: "defaults" | "runtime";
  taskId?: string;
  namespace?: string;
  release?: string;
  secret?: string;
  host?: string;
  hostSuffix?: string;
  sharedNamespace?: string;
  sharedRelease?: string;
  apiImage?: string;
  workerImage?: string;
  webImage?: string;
  publicSiteImage?: string;
  gatewayImage?: string;
  batchRuntimeImage?: string;
  gatewayJwtSecretVersion?: string;
  output: string;
};

const DEFAULT_HEADER =
  "# Derived from platform/dev/worktree/worktree-runtime-plan.ts via render-worktree-values.ts --mode defaults.\n";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renderScalar(value: string | number | boolean | null): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === "") {
    return '""';
  }
  if (/^[A-Za-z0-9._/-]+$/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

function renderYamlValue(value: unknown, indent = 0): string {
  const indentText = " ".repeat(indent);

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return `${indentText}[]\n`;
    }
    return value
      .map((item) => {
        if (isPlainObject(item)) {
          return `${indentText}-\n${renderYamlObject(item, indent + 2)}`;
        }
        if (Array.isArray(item)) {
          return `${indentText}-\n${renderYamlValue(item, indent + 2)}`;
        }
        return `${indentText}- ${renderScalar(item as string | number | boolean | null)}\n`;
      })
      .join("");
  }

  if (isPlainObject(value)) {
    return renderYamlObject(value, indent);
  }

  return `${indentText}${renderScalar(value as string | number | boolean | null)}\n`;
}

function renderYamlObject(value: Record<string, unknown>, indent = 0): string {
  const indentText = " ".repeat(indent);

  return Object.entries(value)
    .map(([key, child]) => {
      if (isPlainObject(child)) {
        return `${indentText}${key}:\n${renderYamlObject(child, indent + 2)}`;
      }
      if (Array.isArray(child)) {
        return `${indentText}${key}:\n${renderYamlValue(child, indent + 2)}`;
      }
      return `${indentText}${key}: ${renderScalar(child as string | number | boolean | null)}\n`;
    })
    .join("");
}

function parseCli(argv: string[]): CliOptions {
  const program = new Command()
    .option("--mode <defaults|runtime>", "Render mode", "defaults")
    .option("--task-id <id>", "Task/worktree id for runtime overlay rendering")
    .option("--namespace <name>", "Worktree namespace override")
    .option("--release <name>", "Worktree Helm release override")
    .option("--secret <name>", "Worktree secret name override")
    .option("--host <fqdn>", "Worktree ingress host override")
    .option("--host-suffix <suffix>", "Worktree ingress host suffix override")
    .option("--shared-namespace <name>", "Shared infra namespace override")
    .option("--shared-release <name>", "Shared infra release override")
    .option("--api-image <ref>", "API image ref for runtime overlay")
    .option("--worker-image <ref>", "Worker image ref for runtime overlay")
    .option("--web-image <ref>", "Web image ref for runtime overlay")
    .option("--public-site-image <ref>", "Public-site image ref for runtime overlay")
    .option("--gateway-image <ref>", "Gateway image ref for runtime overlay")
    .option("--batch-runtime-image <ref>", "Batch runtime image ref for runtime overlay")
    .option("--gateway-jwt-secret-version <value>", "Gateway secret resourceVersion")
    .option("--output <path>", "Write the rendered values to a file", "")
    .parse(["bun", "render-worktree-values", ...argv]);

  return program.opts<CliOptions>();
}

function renderDefaults(): string {
  return `${DEFAULT_HEADER}${renderYamlObject(resolveWorktreeBaseValues())}`;
}

function renderRuntime(cli: CliOptions): string {
  if (!cli.taskId?.trim()) {
    throw new Error("[render-worktree-values] --task-id is required for --mode runtime");
  }

  const plan = resolveWorktreeRuntimePlan({
    taskId: cli.taskId,
    namespace: cli.namespace,
    release: cli.release,
    secretName: cli.secret,
    publicHost: cli.host,
    hostSuffix: cli.hostSuffix,
    sharedNamespace: cli.sharedNamespace,
    sharedRelease: cli.sharedRelease,
  });
  const values = resolveWorktreeRuntimeValues(plan, {
    apiImage: cli.apiImage ?? "",
    workerImage: cli.workerImage ?? "",
    webImage: cli.webImage ?? "",
    publicSiteImage: cli.publicSiteImage ?? "",
    gatewayImage: cli.gatewayImage ?? "",
    batchRuntimeImage: cli.batchRuntimeImage ?? "",
    gatewayJwtSecretVersion: cli.gatewayJwtSecretVersion ?? "",
  });

  return renderYamlObject(values);
}

function main(argv: string[]) {
  const cli = parseCli(argv);
  const rendered = cli.mode === "runtime" ? renderRuntime(cli) : renderDefaults();

  if (cli.output.trim()) {
    writeFileSync(path.resolve(cli.output), rendered, "utf8");
    return;
  }

  process.stdout.write(rendered);
}

main(process.argv.slice(2));
