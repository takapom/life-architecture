import path from "node:path";

import { normalizePathPattern } from "./issue-graph-types";

export function globPrefix(pattern: string): string {
  const normalized = normalizePathPattern(pattern);
  const starIndex = normalized.search(/[*?[]/);
  if (starIndex === -1) return normalized;
  return normalized.slice(0, starIndex).replace(/\/+$/, "");
}

export function overlapsPathPattern(left: string, right: string): boolean {
  const a = normalizePathPattern(left);
  const b = normalizePathPattern(right);

  if (!a || !b) return false;
  if (a === b) return true;

  const aHasGlob = /[*?[]/.test(a);
  const bHasGlob = /[*?[]/.test(b);

  if (!aHasGlob && !bHasGlob) return false;
  if (!aHasGlob) return path.posix.matchesGlob(a, b);
  if (!bHasGlob) return path.posix.matchesGlob(b, a);

  const aPrefix = globPrefix(a);
  const bPrefix = globPrefix(b);

  if (!aPrefix || !bPrefix) return true;
  if (aPrefix === bPrefix) return true;
  if (aPrefix.startsWith(`${bPrefix}/`) || bPrefix.startsWith(`${aPrefix}/`)) return true;

  return false;
}
