import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveRepoRoot } from "./cli";
import { ensureManagedRustToolBinary, resolveRustToolTargetDir } from "./rust-runtime";

export const MANAGED_RUST_TARGET_DIR_ENV = "OMTA_MANAGED_RUST_TARGET_DIR";

export function runRustSubcommand(options: {
  args?: string[];
  captureOutput?: boolean;
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
  scriptUrl: string;
  subcommand: string;
  targetDir?: string;
}) {
  const _scriptDir = path.dirname(fileURLToPath(options.scriptUrl));
  const repoRoot = options.repoRoot ?? resolveRepoRoot();
  const env = {
    // biome-ignore lint/style/noProcessEnv: runtime wrappers must inherit the caller environment and then layer an explicit managed target-dir override when provided.
    ...process.env,
    ...options.env,
  };
  const cargoTargetDir =
    options.targetDir ||
    env[MANAGED_RUST_TARGET_DIR_ENV] ||
    resolveRustToolTargetDir({
      repoRoot,
      toolId: "repoctl",
    });
  const binaryPath = ensureManagedRustToolBinary({
    repoRoot,
    targetDir: cargoTargetDir,
    toolId: "repoctl",
  });
  const sharedOptions = {
    cwd: repoRoot,
    env: {
      ...env,
      CARGO_TARGET_DIR: cargoTargetDir,
    },
    encoding: "utf8" as const,
    stdio: options.captureOutput ? (["ignore", "pipe", "pipe"] as const) : ("inherit" as const),
  };

  return spawnSync(binaryPath, [options.subcommand, ...(options.args ?? [])], sharedOptions);
}

export function runRustSubcommandCli(options: {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  normalizeArgs?: (argv: string[]) => string[];
  repoRoot?: string;
  scriptUrl: string;
  subcommand: string;
  targetDir?: string;
}): never {
  const argv = options.argv ?? process.argv.slice(2);
  const args = options.normalizeArgs ? options.normalizeArgs(argv) : argv;

  let result: ReturnType<typeof runRustSubcommand>;
  try {
    result = runRustSubcommand({
      args,
      env: options.env,
      repoRoot: options.repoRoot,
      scriptUrl: options.scriptUrl,
      subcommand: options.subcommand,
      targetDir: options.targetDir,
    });
  } catch (error) {
    process.stderr.write(`${options.subcommand} failed: ${(error as Error).message}\n`);
    process.exit(1);
  }

  if (result.error) {
    process.stderr.write(
      `${options.subcommand} failed to launch binary: ${result.error.message}\n`
    );
    process.exit(1);
  }

  if (result.signal) {
    process.kill(process.pid, result.signal);
  }

  process.exit(result.status ?? 1);
}
