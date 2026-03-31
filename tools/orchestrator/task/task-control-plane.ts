export type CanonicalTaskProgressState = "open" | "closed";
export type TaskBoardStatus = "backlog" | "ready" | "in progress" | "in review" | "done";

export type TaskControlPlaneFieldRequirement = {
  canonicalName: string;
  acceptedDataTypes: string[];
};

export type TaskControlPlaneFieldSchemaEntry = {
  name: string;
  dataType: string;
};

export type TaskControlPlaneInvalidDataType = {
  fieldName: string;
  expectedDataTypes: string[];
  actualDataType: string;
};

export type TaskControlPlaneFieldSchemaReport = {
  missingRuntimeFields: string[];
  invalidDataTypes: TaskControlPlaneInvalidDataType[];
};

// Field aliases normalize GitHub control-plane schema variants onto one
// canonical issue-only task runtime model.
export const TASK_CONTROL_PLANE_FIELD_ALIASES = {
  task_id: ["Task ID", "task_id"],
  task_type: ["Task Type", "task_type"],
  status: ["Status", "status"],
  priority: ["Priority", "priority"],
  run_id: ["Run ID", "run_id"],
  claimed_by: ["Claimed By", "claimed_by"],
  lease_expires_at: ["Lease Expires At", "lease_expires_at"],
  pr_url: ["PR URL", "pr_url"],
  failure_reason: ["Failure Reason", "failure_reason"],
  updated_at: ["Updated At", "updated_at"],
} as const;

export const TASK_RUNTIME_FIELD_REQUIREMENTS: TaskControlPlaneFieldRequirement[] = [
  { canonicalName: "Run ID", acceptedDataTypes: ["TEXT"] },
  { canonicalName: "Claimed By", acceptedDataTypes: ["TEXT"] },
  { canonicalName: "Lease Expires At", acceptedDataTypes: ["TEXT"] },
  { canonicalName: "PR URL", acceptedDataTypes: ["TEXT"] },
  { canonicalName: "Failure Reason", acceptedDataTypes: ["TEXT"] },
  { canonicalName: "Updated At", acceptedDataTypes: ["TEXT"] },
];

const LEGACY_TASK_BOARD_STATUSES: TaskBoardStatus[] = [
  "backlog",
  "ready",
  "in progress",
  "in review",
  "done",
];

function normalizeToken(value: string): string {
  return value.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

export function normalizeCanonicalTaskProgressState(
  value: string
): CanonicalTaskProgressState | "" {
  const normalized = normalizeToken(value);
  if (normalized === "open" || normalized === "closed") {
    return normalized;
  }
  return "";
}

export function normalizeTaskBoardStatus(value: string): TaskBoardStatus | "" {
  const normalized = normalizeToken(value);
  return (LEGACY_TASK_BOARD_STATUSES.find((status) => status === normalized) ?? "") as
    | TaskBoardStatus
    | "";
}

export function getTaskControlPlaneFieldNames(): string[] {
  return TASK_RUNTIME_FIELD_REQUIREMENTS.map((entry) => entry.canonicalName);
}

export function buildTaskControlPlaneFieldSchemaReport(
  fields: TaskControlPlaneFieldSchemaEntry[]
): TaskControlPlaneFieldSchemaReport {
  const fieldMap = new Map(
    fields.map((field) => [normalizeToken(field.name), field.dataType.trim().toUpperCase()])
  );
  const invalidDataTypes: TaskControlPlaneInvalidDataType[] = [];
  const missingRuntimeFields: string[] = [];

  for (const requirement of TASK_RUNTIME_FIELD_REQUIREMENTS) {
    const actualDataType = fieldMap.get(normalizeToken(requirement.canonicalName)) || "";
    if (!actualDataType) {
      missingRuntimeFields.push(requirement.canonicalName);
      continue;
    }
    if (!requirement.acceptedDataTypes.includes(actualDataType)) {
      invalidDataTypes.push({
        fieldName: requirement.canonicalName,
        expectedDataTypes: requirement.acceptedDataTypes,
        actualDataType,
      });
    }
  }

  return {
    missingRuntimeFields,
    invalidDataTypes,
  };
}

export function isTaskControlPlaneSchemaSatisfied(
  report: TaskControlPlaneFieldSchemaReport
): boolean {
  return report.missingRuntimeFields.length === 0 && report.invalidDataTypes.length === 0;
}
