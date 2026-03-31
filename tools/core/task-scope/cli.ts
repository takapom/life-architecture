import { canonicalPath } from "../../../platform/dev/worktree/worktree-topology";
import { fail } from "../../adapters/cli";
import { getExecutionPlanTaskScopeContract } from "../../contracts/execution-plan";
import {
  detectRepositoryFromOrigin,
  extractTaskIdFromBranch,
  normalizeTaskId,
} from "../task-issue-guard";
import { listActiveTaskScopeLocks } from "./locks";
import {
  assertNoTaskWorktreeConflicts,
  assertTaskScopeFiles,
  ensureCurrentTaskSessionArtifacts,
  ensureMaterializedTaskScopeManifest,
  readStagedChangedFiles,
  readTaskScopeManifest,
  resolveTaskScopeManifest,
  resolveTaskScopeManifestPath,
  writeTaskScopeManifest,
} from "./manifest";
import { resolveSerializedScopeKeys, resolveTaskScopeGateKeys } from "./scope-gates";
import { listVerifyCacheEntries } from "./verify-cache";

type CliOptions =
  | {
      branch: string;
      command: "write-manifest";
      checkWorktreeConflicts: boolean;
      repoRoot: string;
      repository: string;
      sourcePath: string;
      taskId: string;
    }
  | {
      branch: string;
      command: "assert-staged-scope";
      repoRoot: string;
      repository: string;
      sourcePath: string;
    }
  | {
      command: "inspect-manifest";
      repoRoot: string;
      taskId: string;
    }
  | {
      command: "list-locks";
      repoRoot: string;
    }
  | {
      command: "list-verify-cache";
      repoRoot: string;
    }
  | {
      allowedFiles: string[];
      availableKeys: string[];
      command: "scope-keys";
      repoRoot: string;
    };

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function parseCli(argv: string[]): CliOptions {
  const command = String(argv[0] || "").trim();
  if (
    command !== "write-manifest" &&
    command !== "assert-staged-scope" &&
    command !== "inspect-manifest" &&
    command !== "list-locks" &&
    command !== "list-verify-cache" &&
    command !== "scope-keys"
  ) {
    fail(
      [
        "Usage:",
        "  bun tools/core/task-scope.ts write-manifest --repo-root <path> --task-id <TASK_ID> [--branch <task/...>] [--repository <owner/repo>] [--source <path>] [--check-worktree-conflicts]",
        "  bun tools/core/task-scope.ts assert-staged-scope --repo-root <path> --branch <task/...> [--repository <owner/repo>] [--source <path>]",
        "  bun tools/core/task-scope.ts inspect-manifest --repo-root <path> --task-id <TASK_ID>",
        "  bun tools/core/task-scope.ts list-locks --repo-root <path>",
        "  bun tools/core/task-scope.ts list-verify-cache --repo-root <path>",
        "  bun tools/core/task-scope.ts scope-keys --repo-root <path> --allowed-file <glob> [--allowed-file <glob> ...] [--available-key <key> ...]",
      ].join("\n")
    );
  }

  let repoRoot = "";
  let repository = "";
  let sourcePath = "";
  let taskId = "";
  let branch = "";
  let checkWorktreeConflicts = false;
  const allowedFiles: string[] = [];
  const availableKeys: string[] = [];

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--repo-root":
        repoRoot = String(argv[index + 1] || "").trim();
        index += 1;
        break;
      case "--repository":
        repository = String(argv[index + 1] || "").trim();
        index += 1;
        break;
      case "--source":
        sourcePath = String(argv[index + 1] || "").trim();
        index += 1;
        break;
      case "--task-id":
        taskId = normalizeTaskId(String(argv[index + 1] || "").trim());
        index += 1;
        break;
      case "--branch":
        branch = String(argv[index + 1] || "").trim();
        index += 1;
        break;
      case "--check-worktree-conflicts":
        checkWorktreeConflicts = true;
        break;
      case "--allowed-file":
        allowedFiles.push(String(argv[index + 1] || "").trim());
        index += 1;
        break;
      case "--available-key":
        availableKeys.push(
          String(argv[index + 1] || "")
            .trim()
            .toLowerCase()
        );
        index += 1;
        break;
      default:
        fail(`unknown argument: ${arg}`);
    }
  }

  if (!repoRoot) {
    fail("--repo-root is required");
  }
  const canonicalRepoRoot = canonicalPath(repoRoot);

  if (command === "inspect-manifest") {
    if (!taskId) {
      fail("--task-id is required");
    }
    return {
      command,
      repoRoot: canonicalRepoRoot,
      taskId,
    };
  }

  if (command === "list-locks" || command === "list-verify-cache") {
    return {
      command,
      repoRoot: canonicalRepoRoot,
    };
  }

  if (command === "scope-keys") {
    return {
      allowedFiles,
      availableKeys,
      command,
      repoRoot: canonicalRepoRoot,
    };
  }

  const resolvedRepository = repository || detectRepositoryFromOrigin(canonicalRepoRoot);
  if (command === "write-manifest") {
    if (!taskId) {
      fail("--task-id is required");
    }
    return {
      branch,
      command,
      checkWorktreeConflicts,
      repoRoot: canonicalRepoRoot,
      repository: resolvedRepository,
      sourcePath,
      taskId,
    };
  }

  if (!branch) {
    fail("--branch is required");
  }
  return {
    command,
    branch,
    repoRoot: canonicalRepoRoot,
    repository: resolvedRepository,
    sourcePath,
  };
}

export function runTaskScopeCli(argv: string[]): void {
  const cli = parseCli(argv);
  if (cli.command === "write-manifest") {
    const sessionArtifacts =
      !cli.sourcePath && cli.branch
        ? ensureCurrentTaskSessionArtifacts({
            branch: cli.branch,
            repoRoot: cli.repoRoot,
            repository: cli.repository,
            taskId: cli.taskId,
          })
        : null;
    const sourcePath = cli.sourcePath || sessionArtifacts?.sourcePath || undefined;
    const manifest =
      sessionArtifacts?.manifest ||
      resolveTaskScopeManifest({
        repository: cli.repository,
        sourcePath,
        taskId: cli.taskId,
      });
    if (cli.checkWorktreeConflicts) {
      assertNoTaskWorktreeConflicts({
        manifest,
        repoRoot: cli.repoRoot,
        repository: cli.repository,
        sourcePath,
      });
    }
    const manifestPath = writeTaskScopeManifest({
      repoRoot: cli.repoRoot,
      manifest,
    });
    process.stdout.write(`[task-scope] wrote ${manifestPath}\n`);
    return;
  }

  if (cli.command === "inspect-manifest") {
    const manifest = readTaskScopeManifest(cli.repoRoot, cli.taskId);
    if (!manifest) {
      fail(`task-scope manifest is missing for ${cli.taskId} under ${cli.repoRoot}`);
    }
    writeJson({
      ...manifest,
      manifestPath: resolveTaskScopeManifestPath(cli.repoRoot, cli.taskId),
    });
    return;
  }

  if (cli.command === "list-locks") {
    writeJson(listActiveTaskScopeLocks(cli.repoRoot));
    return;
  }

  if (cli.command === "list-verify-cache") {
    writeJson(listVerifyCacheEntries(cli.repoRoot));
    return;
  }

  if (cli.command === "scope-keys") {
    const scopeGateKeys = resolveTaskScopeGateKeys({
      allowedFiles: cli.allowedFiles,
      availableKeys: cli.availableKeys,
    });
    writeJson({
      scopeGateKeys,
      serializedScopeKeys: resolveSerializedScopeKeys(
        scopeGateKeys,
        getExecutionPlanTaskScopeContract().serialized_scope_key_by_scope_gate_key
      ),
    });
    return;
  }

  const taskId = normalizeTaskId(extractTaskIdFromBranch(cli.branch) || "");
  if (!taskId) {
    fail(`failed to resolve task id from branch: ${cli.branch}`);
  }
  const { manifest } = ensureMaterializedTaskScopeManifest({
    repoRoot: cli.repoRoot,
    repository: cli.repository,
    sourcePath: cli.sourcePath || undefined,
    taskId,
  });
  const stagedFiles = readStagedChangedFiles(cli.repoRoot);
  assertTaskScopeFiles({
    changedFiles: stagedFiles,
    manifest,
  });
  process.stdout.write(`[task-scope] staged diff is within Allowed Files for ${taskId}\n`);
}
