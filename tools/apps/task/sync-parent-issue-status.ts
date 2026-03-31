#!/usr/bin/env bun

import { runLegacyTsEntrypoint } from "../shared/legacy-entrypoint";

runLegacyTsEntrypoint("orchestrator/task/sync-parent-issue-status.ts");
