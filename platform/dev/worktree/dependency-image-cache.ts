#!/usr/bin/env bun

import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

import {
  ensureDependencyImage,
  resolveDependencyImageCacheLayout,
  resolveDependencyImageRoot,
} from "../shared/dependency-image-cache";

type CliOptions = {
  command: "ensure-from-source" | "paths";
  depImageId: string;
  repoRoot: string;
  sourceNodeModules: string;
};

function fail(message: string): never {
  process.stderr.write(`[dependency-image-cache] ERROR: ${message}\n`);
  process.exit(1);
}

function usage(): string {
  return `Usage:
  bun platform/dev/worktree/dependency-image-cache.ts paths --repo-root <path> --dep-image-id <id>
  bun platform/dev/worktree/dependency-image-cache.ts ensure-from-source --repo-root <path> --dep-image-id <id> --source-node-modules <path>`;
}

function parseArgs(argv: string[]): CliOptions {
  const command = String(argv[0] || "").trim() as CliOptions["command"];
  let repoRoot = "";
  let depImageId = "";
  let sourceNodeModules = "";

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--repo-root":
        repoRoot = String(argv[index + 1] || "").trim();
        index += 1;
        break;
      case "--dep-image-id":
        depImageId = String(argv[index + 1] || "").trim();
        index += 1;
        break;
      case "--source-node-modules":
        sourceNodeModules = String(argv[index + 1] || "").trim();
        index += 1;
        break;
      case "--help":
      case "-h":
        process.stdout.write(`${usage()}\n`);
        process.exit(0);
        break;
      default:
        fail(`unknown argument: ${arg}`);
    }
  }

  if (command !== "paths" && command !== "ensure-from-source") {
    fail(usage());
  }
  if (!repoRoot || !depImageId) {
    fail("--repo-root and --dep-image-id are required");
  }
  if (command === "ensure-from-source" && !sourceNodeModules) {
    fail("--source-node-modules is required for ensure-from-source");
  }

  return {
    command,
    depImageId,
    repoRoot: path.resolve(repoRoot),
    sourceNodeModules: path.resolve(sourceNodeModules || "."),
  };
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  if (cli.command === "paths") {
    process.stdout.write(
      `${JSON.stringify(
        {
          depImageId: cli.depImageId,
          imageRoot: resolveDependencyImageRoot(cli.repoRoot, cli.depImageId),
          layout: resolveDependencyImageCacheLayout(cli.repoRoot),
        },
        null,
        2
      )}\n`
    );
    return;
  }

  if (!existsSync(cli.sourceNodeModules)) {
    fail(`source node_modules does not exist: ${cli.sourceNodeModules}`);
  }

  const result = await ensureDependencyImage({
    repoRoot: cli.repoRoot,
    depImageId: cli.depImageId,
    build(draftRoot) {
      const targetNodeModules = path.join(draftRoot, "node_modules");
      mkdirSync(draftRoot, { recursive: true });
      cpSync(cli.sourceNodeModules, targetNodeModules, { recursive: true });
    },
  });

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

await main();
