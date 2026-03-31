#!/usr/bin/env bun

import { parseCli } from "./issue/cli";
import { runIssueCli } from "./issue/flow";
import {
  applyParentIssueReferenceForCommand as applyParentIssueReferenceForCommandCore,
  extractTaskIdFromIssueBody as extractTaskIdFromIssueBodyCore,
  parseUpsertItemsForCommand as parseUpsertItemsForCommandCore,
} from "./issue/payload";
import { collectOpenIssueTargetsByTaskId as collectOpenIssueTargetsByTaskIdCore } from "./issue/repository";

export const extractTaskIdFromIssueBody = extractTaskIdFromIssueBodyCore;
export const parseUpsertItemsForCommand = parseUpsertItemsForCommandCore;
export const applyParentIssueReferenceForCommand = applyParentIssueReferenceForCommandCore;
export const collectOpenIssueTargetsByTaskId = collectOpenIssueTargetsByTaskIdCore;

if (import.meta.main) {
  runIssueCli(parseCli(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`issue failed: ${(error as Error).message}\n`);
    process.exit(1);
  });
}
