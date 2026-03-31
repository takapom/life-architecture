function normalizeListItem(value: string): string {
  return String(value || "")
    .trim()
    .replace(/^[-*+]\s+\[[ xX]\]\s+/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+\.\s+/, "")
    .trim();
}

function isEmptyListSentinel(value: string): boolean {
  return value === "" || value === "_No response_" || value === "N/A";
}

type ListParseMode = "token-list" | "bullet-prose" | "checklist-prose";

function parseStringListValue(value: string, mode: ListParseMode): string[] {
  const normalized = String(value || "").trim();
  if (isEmptyListSentinel(normalized)) {
    return [];
  }

  const lines = normalized
    .split(/\r?\n/)
    .map(normalizeListItem)
    .filter((entry) => !isEmptyListSentinel(entry));

  if (lines.length === 0) {
    return [];
  }

  if (mode !== "token-list" || lines.length > 1) {
    return [...new Set(lines)];
  }

  return [
    ...new Set(
      lines[0]
        ?.split(",")
        .map(normalizeListItem)
        .filter((entry) => !isEmptyListSentinel(entry)) || []
    ),
  ];
}

function parseListValue(value: unknown, mode: ListParseMode): string[] {
  if (Array.isArray(value)) {
    return [...new Set(value.flatMap((entry) => parseStringListValue(String(entry ?? ""), mode)))];
  }

  if (typeof value === "number") {
    return parseStringListValue(String(value), mode);
  }

  return parseStringListValue(String(value || ""), mode);
}

export function parseTokenListValue(value: unknown): string[] {
  return parseListValue(value, "token-list");
}

export function parseBulletProseListValue(value: unknown): string[] {
  return parseListValue(value, "bullet-prose");
}

export function parseChecklistProseListValue(value: unknown): string[] {
  return parseListValue(value, "checklist-prose");
}

export function parseProseListValue(value: unknown): string[] {
  return parseBulletProseListValue(value);
}
