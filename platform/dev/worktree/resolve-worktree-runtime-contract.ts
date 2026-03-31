#!/usr/bin/env bun

import { writeFileSync } from "node:fs";
import path from "node:path";

import { Command } from "commander";

import { resolveWorktreeRuntimePlan } from "./worktree-runtime-plan.ts";

type CliOptions = {
  taskId: string;
  namespace?: string;
  release?: string;
  secret?: string;
  dbName?: string;
  dbUser?: string;
  bucketName?: string;
  host?: string;
  hostSuffix?: string;
  sharedNamespace?: string;
  sharedRelease?: string;
  format: "json" | "shell";
  output: string;
};

function parseCli(argv: string[]): CliOptions {
  const program = new Command()
    .requiredOption("--task-id <id>", "Task/worktree id")
    .option("--namespace <name>", "Worktree namespace override")
    .option("--release <name>", "Worktree Helm release override")
    .option("--secret <name>", "Worktree secret name override")
    .option("--db-name <name>", "Worktree database name override")
    .option("--db-user <name>", "Worktree database user override")
    .option("--bucket-name <name>", "Worktree bucket name override")
    .option("--host <fqdn>", "Worktree ingress host override")
    .option("--host-suffix <suffix>", "Worktree ingress host suffix override")
    .option("--shared-namespace <name>", "Shared infra namespace override")
    .option("--shared-release <name>", "Shared infra release override")
    .option("--format <json|shell>", "Output format", "json")
    .option("--output <path>", "Write the rendered contract to a file", "")
    .parse(["bun", "resolve-worktree-runtime-contract", ...argv]);

  return program.opts<CliOptions>();
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, String.raw`'\''`)}'`;
}

function renderShell(options: CliOptions): string {
  const plan = resolveWorktreeRuntimePlan({
    taskId: options.taskId,
    namespace: options.namespace,
    release: options.release,
    secretName: options.secret,
    dbName: options.dbName,
    dbUser: options.dbUser,
    bucketName: options.bucketName,
    publicHost: options.host,
    hostSuffix: options.hostSuffix,
    sharedNamespace: options.sharedNamespace,
    sharedRelease: options.sharedRelease,
  });

  const entries = [
    ["WT_TASK_ID", plan.taskId],
    ["WT_ID_DNS", plan.ids.dns],
    ["WT_ID_DB", plan.ids.db],
    ["WT_NAMESPACE", plan.worktree.namespace],
    ["WT_RELEASE", plan.worktree.release],
    ["WT_SECRET_NAME", plan.worktree.secretName],
    ["WT_DB_NAME", plan.inventory.sharedData.database.name],
    ["WT_DB_USER", plan.inventory.sharedData.database.user],
    ["WT_BUCKET_NAME", plan.inventory.sharedData.bucket.name],
    ["WT_PUBLIC_HOST", plan.worktree.publicHost],
    ["WT_HOST_SUFFIX", plan.worktree.hostSuffix],
    ["SHARED_NAMESPACE", plan.shared.namespace],
    ["SHARED_RELEASE", plan.shared.release],
    ["SHARED_POSTGRES_SERVICE", plan.shared.postgresService],
    ["SHARED_MINIO_SERVICE", plan.shared.minioService],
    ["SHARED_REDIS_SERVICE", plan.shared.redisService],
    ["SHARED_TEMPORAL_SERVICE", plan.shared.temporalService],
    ["WT_SHARED_POSTGRES_HOST", plan.shared.postgresHost],
    ["WT_SHARED_MINIO_HOST", plan.shared.minioHost],
    ["WT_SHARED_REDIS_HOST", plan.shared.redisHost],
    ["WT_TEMPORAL_ADDRESS", plan.shared.temporalAddress],
    ["WT_API_BASE_URL", plan.urls.apiBaseUrl],
    ["WT_WEB_ORIGIN_URL", plan.urls.webOriginUrl],
    ["WT_PUBLIC_SITE_ORIGIN_URL", plan.urls.publicSiteOriginUrl],
    ["WT_SOCKET_REDIS_URL", plan.urls.socketRedisUrl],
    ["WT_MINIO_ENDPOINT", plan.urls.minioEndpoint],
  ];

  return `${entries.map(([key, value]) => `${key}=${shellQuote(value)}`).join("\n")}\n`;
}

function renderJson(options: CliOptions): string {
  const plan = resolveWorktreeRuntimePlan({
    taskId: options.taskId,
    namespace: options.namespace,
    release: options.release,
    secretName: options.secret,
    dbName: options.dbName,
    dbUser: options.dbUser,
    bucketName: options.bucketName,
    publicHost: options.host,
    hostSuffix: options.hostSuffix,
    sharedNamespace: options.sharedNamespace,
    sharedRelease: options.sharedRelease,
  });

  return `${JSON.stringify(plan, null, 2)}\n`;
}

function main(argv: string[]) {
  const cli = parseCli(argv);
  const rendered = cli.format === "shell" ? renderShell(cli) : renderJson(cli);

  if (cli.output.trim()) {
    writeFileSync(path.resolve(cli.output), rendered, "utf8");
    return;
  }

  process.stdout.write(rendered);
}

main(process.argv.slice(2));
