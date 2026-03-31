import { ensureInteger, ensureString, fail, usage } from "./common";
import type { IssueReference, ParsedCli } from "./contracts";

export function parseCli(argv: string[]): ParsedCli {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }

  const command = argv[0] ?? "";
  const flags = new Map<string, string | true>();
  const allowedFlags = new Set([
    "input",
    "repository",
    "issue-number",
    "parent-issue",
    "create-only",
    "dry-run",
    "output",
  ]);

  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i] ?? "";
    if (!token.startsWith("--")) {
      fail(`unexpected positional argument: ${token}`);
    }
    const key = token.slice(2);
    if (!key) {
      fail("invalid empty flag");
    }
    if (!allowedFlags.has(key)) {
      fail(`unknown flag: --${key}`);
    }
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      flags.set(key, true);
      continue;
    }
    flags.set(key, next);
    i += 1;
  }

  for (const [key, value] of flags.entries()) {
    if (value === true && key !== "dry-run" && key !== "create-only") {
      fail(`--${key} requires a value`);
    }
  }

  return { command, flags };
}

export function getFlag(flags: Map<string, string | true>, key: string): string {
  const value = flags.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export function hasBoolFlag(flags: Map<string, string | true>, key: string): boolean {
  return flags.get(key) === true;
}

export function mustNotBoolFlag(flags: Map<string, string | true>, key: string): void {
  if (flags.get(key) === true) {
    fail(`--${key} requires a value`);
  }
}

function parseRepository(repository: string): { owner: string; repo: string } {
  const trimmed = ensureString(repository, "repository");
  const parts = trimmed.split("/").filter(Boolean);
  if (parts.length !== 2) {
    fail(`repository must be <owner>/<repo>: ${repository}`);
  }
  return { owner: parts[0], repo: parts[1] };
}

export function resolveRequiredRepository(flags: Map<string, string | true>): string {
  mustNotBoolFlag(flags, "repository");
  const repository = getFlag(flags, "repository");
  if (!repository) {
    fail("--repository is required");
  }
  parseRepository(repository);
  return repository;
}

export function canonicalRepositorySlug(repository: string): string {
  const parsed = parseRepository(repository);
  return `${parsed.owner.toLowerCase()}/${parsed.repo.toLowerCase()}`;
}

export function assertIssueReferenceRepository(
  repository: string,
  referenceRepository: string,
  field: string
): void {
  if (!referenceRepository) return;
  if (canonicalRepositorySlug(repository) !== canonicalRepositorySlug(referenceRepository)) {
    fail(
      [
        `${field} repository mismatch`,
        `expected=${repository}`,
        `actual=${referenceRepository}`,
      ].join(" | ")
    );
  }
}

export function parseIssueReference(value: unknown, field: string): IssueReference {
  if (value === undefined || value === null || value === "") {
    fail(`${field} is required`);
  }
  if (typeof value === "number") {
    return {
      issueNumber: ensureInteger(value, field),
      repository: "",
    };
  }
  if (typeof value !== "string") {
    fail(`${field} must be an issue number or issue URL`);
  }

  const trimmed = value.trim();
  if (!trimmed) {
    fail(`${field} is required`);
  }
  if (/^\d+$/.test(trimmed)) {
    return {
      issueNumber: ensureInteger(trimmed, field),
      repository: "",
    };
  }
  const matched = trimmed.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/i);
  if (!matched) {
    fail(`${field} must be an issue number or issue URL`);
  }
  return {
    issueNumber: ensureInteger(matched[3], `${field}.issue_number`),
    repository: `${matched[1].toLowerCase()}/${matched[2].toLowerCase()}`,
  };
}

export function resolveSingleIssueNumberFlag(flags: Map<string, string | true>): number {
  mustNotBoolFlag(flags, "issue-number");
  const raw = getFlag(flags, "issue-number");
  if (!raw) return 0;
  return ensureInteger(raw, "issue-number");
}

export function resolveParentIssueReferenceFlag(
  flags: Map<string, string | true>
): IssueReference | null {
  mustNotBoolFlag(flags, "parent-issue");
  const raw = getFlag(flags, "parent-issue");
  if (!raw) {
    return null;
  }
  return parseIssueReference(raw, "parent-issue");
}
