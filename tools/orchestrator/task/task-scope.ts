#!/usr/bin/env bun

import { runTaskScopeCli } from "../../core/task-governance";

try {
  runTaskScopeCli(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`[task-scope] ERROR: ${(error as Error).message}\n`);
  process.exit(1);
}
