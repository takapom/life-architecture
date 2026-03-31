import { fail } from "../../../adapters/cli";
import { currentGitBranch } from "../../../core/task-governance";
import type { Cli } from "./contracts";

function usage(): string {
  return `Usage:
  bun run pr:publish -- [options]

Options:
  --branch <task/...>    Publish branch (defaults to current branch; required when HEAD is detached)
  --head <ref>           Source ref to push (default: HEAD)
  --base <branch>        Pull request base branch (default: main)
  --title <text>         PR title override (default: canonical task issue title)
  --body-file <path>     Write the generated canonical PR body to this path before publish
  --repository <owner/repo>
                        Repository slug override (default: resolve from origin)
  --source <path>        Offline task issue JSON source (tests)
  --draft                Create a draft PR when no open PR exists yet
  --force-with-lease     Use force-with-lease for the publish push
  --dry-run              Print commands without mutating git state
  --help                 Show this help`;
}

function printUsageAndExit(): never {
  process.stdout.write(`${usage()}\n`);
  process.exit(0);
}

function takeRequiredOptionValue(argv: string[], index: number, flag: string): string {
  const next = argv[index + 1];
  if (!next || next.startsWith("--")) {
    fail(`${flag} requires a value`);
  }
  return next;
}

export function parseCli(argv: string[]): Cli {
  const cli: Cli = {
    repository: "",
    sourcePath: "",
    branch: "",
    headRef: "HEAD",
    baseBranch: "main",
    title: "",
    bodyFile: "",
    draft: false,
    dryRun: false,
    forceWithLease: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--repository":
        cli.repository = takeRequiredOptionValue(argv, index, "--repository").trim();
        index += 1;
        break;
      case "--source":
        cli.sourcePath = takeRequiredOptionValue(argv, index, "--source").trim();
        index += 1;
        break;
      case "--branch":
        cli.branch = takeRequiredOptionValue(argv, index, "--branch").trim();
        index += 1;
        break;
      case "--head":
        cli.headRef = takeRequiredOptionValue(argv, index, "--head").trim() || "HEAD";
        index += 1;
        break;
      case "--base":
        cli.baseBranch = takeRequiredOptionValue(argv, index, "--base").trim() || "main";
        index += 1;
        break;
      case "--title":
        cli.title = takeRequiredOptionValue(argv, index, "--title").trim();
        index += 1;
        break;
      case "--body-file":
        cli.bodyFile = takeRequiredOptionValue(argv, index, "--body-file").trim();
        index += 1;
        break;
      case "--draft":
        cli.draft = true;
        break;
      case "--force-with-lease":
        cli.forceWithLease = true;
        break;
      case "--dry-run":
        cli.dryRun = true;
        break;
      case "--help":
      case "-h":
        return printUsageAndExit();
      default:
        fail(`unknown argument: ${arg}`);
    }
  }

  return cli;
}

export function resolveBranch(cli: Pick<Cli, "branch">, repoRoot: string): string {
  if (cli.branch) {
    return cli.branch;
  }
  const branch = currentGitBranch(repoRoot);
  if (branch === "HEAD") {
    fail("--branch is required when HEAD is detached");
  }
  return branch;
}
