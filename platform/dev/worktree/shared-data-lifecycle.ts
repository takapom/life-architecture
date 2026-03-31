#!/usr/bin/env bun

import { spawnSync } from "node:child_process";

import { ADVISORY_LOCK_KEY_FUNCTION_DDL, RLS_ROLES_SETUP_SQL } from "@omta/db/schema";
import { Command } from "commander";

import { resolveWorktreeRuntimePlan } from "./worktree-runtime-plan.ts";

type CliOptions = {
  format: "text" | "json" | "shell";
  taskId: string;
  namespace?: string;
  secret?: string;
  dbName?: string;
  dbUser?: string;
  dbPassword?: string;
  bucketName?: string;
  sharedNamespace?: string;
  sharedRelease?: string;
  minioMcImage?: string;
};

type EnsureResult = {
  taskId: string;
  dbName: string;
  dbUser: string;
  bucketName: string;
  postgresAdminUser: string;
  postgresAdminPassword: string;
};

type PurgeResult = {
  taskId: string;
  dbName: string;
  dbUser: string;
  bucketName: string;
};

type SharedDataPlanContext = {
  plan: ReturnType<typeof resolveWorktreeRuntimePlan>;
  taskId: string;
  dbName: string;
  dbUser: string;
  bucketName: string;
  minioMcImage: string;
  minioPodName: string;
};

type LifecycleContext = SharedDataPlanContext & {
  postgresAdminUser: string;
  postgresAdminPassword: string;
  minioRootUser: string;
  minioRootPassword: string;
};

type LifecycleDeps = {
  resolveLifecycleContext: (
    options: CliOptions,
    planContext?: SharedDataPlanContext
  ) => LifecycleContext;
  runPsqlAdmin: typeof runPsqlAdmin;
  runMinioLifecycle: typeof runMinioLifecycle;
  writeStderrLine: (line: string) => void;
};

function parseCli(argv: string[]) {
  const [mode, ...rest] = argv;
  if (mode !== "ensure" && mode !== "purge") {
    throw new Error("[wt-shared-data] first argument must be ensure or purge");
  }

  const program = new Command()
    .option("--format <text|json|shell>", "Output format", "text")
    .requiredOption("--task-id <id>", "Task/worktree id")
    .option("--namespace <name>", "Worktree namespace override")
    .option("--secret <name>", "Worktree secret override")
    .option("--db-name <name>", "Worktree database name override")
    .option("--db-user <name>", "Worktree database user override")
    .option("--db-password <value>", "Worktree database password (ensure only)")
    .option("--bucket-name <name>", "Worktree bucket name override")
    .option("--shared-namespace <name>", "Shared infra namespace override")
    .option("--shared-release <name>", "Shared infra release override")
    .option("--minio-mc-image <ref>", "MinIO mc image for bucket lifecycle orchestration")
    .parse(["bun", "shared-data-lifecycle", ...rest]);

  return {
    mode,
    options: program.opts<CliOptions>(),
  };
}

function fail(message: string): never {
  throw new Error(`[wt-shared-data] ${message}`);
}

function writeStderrLine(line: string): void {
  process.stderr.write(`${line}\n`);
}

function runtimeEnv(): NodeJS.ProcessEnv {
  // biome-ignore lint/style/noProcessEnv: worktree shared-data lifecycle commands must use the live operator environment.
  return process.env;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, String.raw`'\''`)}'`;
}

function requireNonEmpty(name: string, value?: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    fail(`${name} is required`);
  }
  return trimmed;
}

function requireLifecycleToken(name: string, value?: string): string {
  const trimmed = requireNonEmpty(name, value);
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    fail(`${name} contains unsupported characters: ${trimmed}`);
  }
  return trimmed;
}

function trimName(value: string, maxLength: number): string {
  const trimmed = value.slice(0, maxLength).replace(/[-_]+$/g, "");
  return trimmed || "wt";
}

function runCommand(command: string, args: string[], input = ""): string {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    input,
    env: runtimeEnv(),
  });

  if (result.status !== 0) {
    const rendered = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    fail(`${command} ${args.join(" ")} failed${rendered ? `:\n${rendered}` : ""}`);
  }

  return result.stdout;
}

function readSecretValue(namespace: string, secretName: string, key: string): string {
  return runCommand("kubectl", [
    "-n",
    namespace,
    "get",
    "secret",
    secretName,
    "-o",
    `go-template={{ index .data "${key}" | base64decode }}`,
  ]).trim();
}

function deletePodIfExists(namespace: string, podName: string) {
  runCommand("kubectl", ["-n", namespace, "delete", "pod", podName, "--ignore-not-found"]);
}

function runPsqlAdmin(
  namespace: string,
  service: string,
  adminUser: string,
  adminPassword: string,
  database: string,
  sql: string,
  variables: Record<string, string>
) {
  const args = [
    "-n",
    namespace,
    "exec",
    "-i",
    `deploy/${service}`,
    "--",
    "env",
    `PGPASSWORD=${adminPassword}`,
    "psql",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    adminUser,
    "-d",
    database,
  ];

  for (const [key, value] of Object.entries(variables)) {
    args.push("-v", `${key}=${value}`);
  }

  runCommand("kubectl", args, sql);
}

function runMinioLifecycle(
  namespace: string,
  podName: string,
  minioMcImage: string,
  minioService: string,
  minioUser: string,
  minioPassword: string,
  command: string
) {
  deletePodIfExists(namespace, podName);
  runCommand("kubectl", [
    "-n",
    namespace,
    "run",
    podName,
    `--image=${minioMcImage}`,
    "--restart=Never",
    "--rm",
    "-i",
    `--env=MINIO_ROOT_USER=${minioUser}`,
    `--env=MINIO_ROOT_PASSWORD=${minioPassword}`,
    "--command",
    "--",
    "sh",
    "-ceu",
    `mc alias set shared http://${minioService}:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null; ${command}`,
  ]);
}

function buildPurgeResult(
  context: Pick<PurgeResult, "taskId" | "dbName" | "dbUser" | "bucketName">
) {
  return {
    taskId: context.taskId,
    dbName: context.dbName,
    dbUser: context.dbUser,
    bucketName: context.bucketName,
  };
}

function resolveSharedDataPlan(options: CliOptions): SharedDataPlanContext {
  const taskId = requireLifecycleToken("taskId", options.taskId);
  const plan = resolveWorktreeRuntimePlan({
    taskId,
    namespace: options.namespace,
    secretName: options.secret,
    dbName: options.dbName,
    dbUser: options.dbUser,
    bucketName: options.bucketName,
    sharedNamespace: options.sharedNamespace,
    sharedRelease: options.sharedRelease,
  });
  const sharedDataInventory = plan.inventory.sharedData;

  const minioMcImage = requireNonEmpty("minioMcImage", options.minioMcImage);
  const bucketName = requireLifecycleToken("bucketName", sharedDataInventory.bucket.name);
  const dbName = requireLifecycleToken("dbName", sharedDataInventory.database.name);
  const dbUser = requireLifecycleToken("dbUser", sharedDataInventory.database.user);
  const minioPodName = trimName(`wt-minio-mc-${plan.ids.dns}`, 63);

  return {
    plan,
    taskId,
    dbName,
    dbUser,
    bucketName,
    minioMcImage,
    minioPodName,
  };
}

export function classifyMissingSharedInfraError(
  errorMessage: string,
  sharedNamespace: string
): "shared-namespace-missing" | "shared-secret-missing" | null {
  const normalized = errorMessage.replace(/\s+/g, " ").trim();
  if (normalized.includes(`namespaces "${sharedNamespace}" not found`)) {
    return "shared-namespace-missing";
  }
  if (
    /Error from server \(NotFound\): secrets? "[^"]+" not found/.test(normalized) ||
    / secrets? "[^"]+" not found/.test(normalized)
  ) {
    return "shared-secret-missing";
  }
  return null;
}

function resolveLifecycleContext(
  options: CliOptions,
  planContext = resolveSharedDataPlan(options)
): LifecycleContext {
  const postgresAdminUser = requireNonEmpty(
    "POSTGRES_USER",
    readSecretValue(
      planContext.plan.shared.namespace,
      planContext.plan.shared.postgresService,
      "POSTGRES_USER"
    )
  );
  const postgresAdminPassword = requireNonEmpty(
    "POSTGRES_PASSWORD",
    readSecretValue(
      planContext.plan.shared.namespace,
      planContext.plan.shared.postgresService,
      "POSTGRES_PASSWORD"
    )
  );
  const minioRootUser = requireNonEmpty(
    "MINIO_ROOT_USER",
    readSecretValue(
      planContext.plan.shared.namespace,
      planContext.plan.shared.minioService,
      "MINIO_ROOT_USER"
    )
  );
  const minioRootPassword = requireNonEmpty(
    "MINIO_ROOT_PASSWORD",
    readSecretValue(
      planContext.plan.shared.namespace,
      planContext.plan.shared.minioService,
      "MINIO_ROOT_PASSWORD"
    )
  );

  return {
    ...planContext,
    postgresAdminUser,
    postgresAdminPassword,
    minioRootUser,
    minioRootPassword,
  };
}

export function ensureLifecycle(
  options: CliOptions,
  deps: LifecycleDeps = {
    resolveLifecycleContext,
    runPsqlAdmin,
    runMinioLifecycle,
    writeStderrLine,
  }
): EnsureResult {
  const context = deps.resolveLifecycleContext(options);
  const dbPassword = requireNonEmpty("dbPassword", options.dbPassword);

  deps.runPsqlAdmin(
    context.plan.shared.namespace,
    context.plan.shared.postgresService,
    context.postgresAdminUser,
    context.postgresAdminPassword,
    "postgres",
    `SELECT format(
  'CREATE ROLE %I LOGIN PASSWORD %L',
  :'db_user',
  :'db_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'db_user')
\\gexec

SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', :'db_user', :'db_password')
\\gexec

SELECT format('CREATE DATABASE %I OWNER %I', :'db_name', :'db_user')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db_name')
\\gexec

SELECT format('ALTER DATABASE %I OWNER TO %I', :'db_name', :'db_user')
\\gexec
`,
    {
      db_name: context.dbName,
      db_user: context.dbUser,
      db_password: dbPassword,
    }
  );

  deps.runPsqlAdmin(
    context.plan.shared.namespace,
    context.plan.shared.postgresService,
    context.postgresAdminUser,
    context.postgresAdminPassword,
    "postgres",
    `${ADVISORY_LOCK_KEY_FUNCTION_DDL};`,
    {}
  );

  deps.runPsqlAdmin(
    context.plan.shared.namespace,
    context.plan.shared.postgresService,
    context.postgresAdminUser,
    context.postgresAdminPassword,
    "postgres",
    RLS_ROLES_SETUP_SQL,
    {}
  );

  deps.runPsqlAdmin(
    context.plan.shared.namespace,
    context.plan.shared.postgresService,
    context.postgresAdminUser,
    context.postgresAdminPassword,
    "postgres",
    `SELECT format('GRANT omta_app TO %I', :'db_user')
\\gexec

SELECT format('GRANT omta_admin TO %I', :'db_user')
\\gexec
`,
    {
      db_user: context.dbUser,
    }
  );

  deps.runPsqlAdmin(
    context.plan.shared.namespace,
    context.plan.shared.postgresService,
    context.postgresAdminUser,
    context.postgresAdminPassword,
    context.dbName,
    `SELECT format('ALTER SCHEMA public OWNER TO %I', :'db_user')
\\gexec
SELECT format('GRANT ALL ON SCHEMA public TO %I', :'db_user')
\\gexec
`,
    {
      db_user: context.dbUser,
    }
  );

  deps.runMinioLifecycle(
    context.plan.shared.namespace,
    context.minioPodName,
    context.minioMcImage,
    context.plan.shared.minioService,
    context.minioRootUser,
    context.minioRootPassword,
    `mc mb --ignore-existing shared/${context.bucketName} >/dev/null`
  );

  return {
    taskId: context.taskId,
    dbName: context.dbName,
    dbUser: context.dbUser,
    bucketName: context.bucketName,
    postgresAdminUser: context.postgresAdminUser,
    postgresAdminPassword: context.postgresAdminPassword,
  };
}

export function purgeLifecycle(
  options: CliOptions,
  deps: LifecycleDeps = {
    resolveLifecycleContext,
    runPsqlAdmin,
    runMinioLifecycle,
    writeStderrLine,
  }
): PurgeResult {
  const planContext = resolveSharedDataPlan(options);
  let context: LifecycleContext;
  try {
    context = deps.resolveLifecycleContext(options, planContext);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const skipReason = classifyMissingSharedInfraError(detail, planContext.plan.shared.namespace);
    if (skipReason) {
      deps.writeStderrLine(
        `[wt-shared-data] purge skipped: ${skipReason} (${planContext.plan.shared.namespace})`
      );
      return buildPurgeResult(planContext);
    }
    throw error;
  }

  deps.runPsqlAdmin(
    context.plan.shared.namespace,
    context.plan.shared.postgresService,
    context.postgresAdminUser,
    context.postgresAdminPassword,
    "postgres",
    `SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = :'db_name' AND pid <> pg_backend_pid();

SELECT format('DROP DATABASE IF EXISTS %I', :'db_name')
\\gexec

SELECT format('DROP ROLE IF EXISTS %I', :'db_user')
\\gexec
`,
    {
      db_name: context.dbName,
      db_user: context.dbUser,
    }
  );

  deps.runMinioLifecycle(
    context.plan.shared.namespace,
    context.minioPodName,
    context.minioMcImage,
    context.plan.shared.minioService,
    context.minioRootUser,
    context.minioRootPassword,
    `mc rm -r --force shared/${context.bucketName} >/dev/null 2>&1 || true; mc rb --force shared/${context.bucketName} >/dev/null 2>&1 || true`
  );

  return buildPurgeResult(context);
}

function renderOutput(
  result: EnsureResult | PurgeResult,
  mode: "ensure" | "purge",
  format: CliOptions["format"]
) {
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (format === "shell") {
    if (mode !== "ensure") {
      return;
    }

    const ensureResult = result as EnsureResult;
    process.stdout.write(
      `${[
        `WT_SHARED_POSTGRES_ADMIN_USER=${shellQuote(ensureResult.postgresAdminUser)}`,
        `WT_SHARED_POSTGRES_ADMIN_PASSWORD=${shellQuote(ensureResult.postgresAdminPassword)}`,
      ].join("\n")}\n`
    );
  }
}

function main(argv: string[]) {
  const { mode, options } = parseCli(argv);
  const result = mode === "ensure" ? ensureLifecycle(options) : purgeLifecycle(options);
  renderOutput(result, mode, options.format);
}

if (import.meta.path === Bun.main) {
  main(process.argv.slice(2));
}
