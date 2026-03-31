#!/usr/bin/env bun

import { runLegacyTsEntrypoint } from "../shared/legacy-entrypoint";

runLegacyTsEntrypoint("orchestrator/task/check-task-pr-steady-state.ts");
