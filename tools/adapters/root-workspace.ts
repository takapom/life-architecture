import { readFileSync } from "node:fs";
import path from "node:path";

type RootWorkspaceConfig =
  | string[]
  | {
      packages?: string[];
      catalog?: Record<string, string>;
    };

type RootPackageJson = {
  workspaces?: RootWorkspaceConfig;
};

function readRootPackageJson(rootDir: string): RootPackageJson {
  return JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8")) as RootPackageJson;
}

export function readWorkspacePatterns(rootDir: string = process.cwd()): string[] {
  const workspaces = readRootPackageJson(rootDir).workspaces;
  const patterns = Array.isArray(workspaces) ? workspaces : workspaces?.packages;
  return (patterns ?? []).filter((value): value is string => typeof value === "string");
}

export function readWorkspaceCatalog(rootDir: string = process.cwd()): Record<string, string> {
  const workspaces = readRootPackageJson(rootDir).workspaces;
  if (Array.isArray(workspaces)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(workspaces?.catalog ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    )
  );
}

export function serializeWorkspaceTopology(rootDir: string = process.cwd()): string {
  return `${JSON.stringify(
    {
      packages: readWorkspacePatterns(rootDir),
      catalog: readWorkspaceCatalog(rootDir),
    },
    null,
    2
  )}\n`;
}
