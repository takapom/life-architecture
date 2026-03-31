import { resolveRepoRoot } from "../../../adapters/cli";
import { canonicalPath } from "../../../adapters/worktree";
import { fail, printUsageAndExit } from "./common";
import type { CliOptions, MergeMethod, MergeMode } from "./contracts";

export function parseArgs(argv: string[]): CliOptions {
  let prValue = "";
  let method: MergeMethod = "squash";
  let repository = "";
  let cleanup = false;
  let cleanupOnly = false;
  let dryRun = false;
  let mergeMode: MergeMode = "auto";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--pr":
        prValue = argv[index + 1] ?? "";
        if (!prValue) {
          fail("missing value for --pr");
        }
        index += 1;
        break;
      case "--method":
        method = (argv[index + 1] ?? "") as MergeMethod;
        if (!method) {
          fail("missing value for --method");
        }
        index += 1;
        break;
      case "--repository":
        repository = argv[index + 1] ?? "";
        if (!repository) {
          fail("missing value for --repository");
        }
        index += 1;
        break;
      case "--cleanup":
        cleanup = true;
        break;
      case "--cleanup-only":
        cleanup = true;
        cleanupOnly = true;
        break;
      case "--no-queue":
        if (mergeMode !== "auto") {
          fail("use either --no-queue or --require-queue, not both");
        }
        mergeMode = "direct";
        break;
      case "--require-queue":
        if (mergeMode !== "auto") {
          fail("use either --no-queue or --require-queue, not both");
        }
        mergeMode = "require-queue";
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--help":
      case "-h":
        return printUsageAndExit();
      default:
        fail(`unknown option: ${arg}`);
    }
  }

  if (!prValue) {
    fail("--pr is required");
  }
  if (!new Set<MergeMethod>(["squash", "merge", "rebase"]).has(method)) {
    fail("--method must be squash|merge|rebase");
  }

  return {
    cleanup,
    cleanupOnly,
    dryRun,
    method,
    mergeMode,
    prValue,
    repository,
    repoRoot: canonicalPath(Bun.env.OMTA_PR_MERGE_REPO_ROOT || resolveRepoRoot()),
  };
}
