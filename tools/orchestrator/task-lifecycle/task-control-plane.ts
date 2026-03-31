export type TaskBoardStatus = "backlog" | "ready" | "in progress" | "in review" | "done";

export type TaskStatusReconciliationReason =
  | "closed_requires_done"
  | "open_done_requires_backlog"
  | "open_invalid_requires_backlog"
  | "none";

export type TaskStatusReconciliationPlan = {
  driftDetected: boolean;
  targetStatus: TaskBoardStatus | null;
  reason: TaskStatusReconciliationReason;
};

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
  missingBoardFields: string[];
  missingRuntimeFields: string[];
  invalidDataTypes: TaskControlPlaneInvalidDataType[];
  legacySpecFieldsPresent: string[];
};

export const TASK_BOARD_STATUSES: TaskBoardStatus[] = [
  "backlog",
  "ready",
  "in progress",
  "in review",
  "done",
];

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

export const TASK_BOARD_FIELD_REQUIREMENTS: TaskControlPlaneFieldRequirement[] = [
  { canonicalName: "Task ID", acceptedDataTypes: ["TEXT"] },
  { canonicalName: "Task Type", acceptedDataTypes: ["SINGLE_SELECT"] },
  { canonicalName: "Status", acceptedDataTypes: ["SINGLE_SELECT"] },
  { canonicalName: "Priority", acceptedDataTypes: ["NUMBER", "SINGLE_SELECT", "TEXT"] },
];

export const TASK_RUNTIME_FIELD_REQUIREMENTS: TaskControlPlaneFieldRequirement[] = [
  { canonicalName: "Run ID", acceptedDataTypes: ["TEXT"] },
  { canonicalName: "Claimed By", acceptedDataTypes: ["TEXT"] },
  { canonicalName: "Lease Expires At", acceptedDataTypes: ["TEXT"] },
  { canonicalName: "PR URL", acceptedDataTypes: ["TEXT"] },
  { canonicalName: "Failure Reason", acceptedDataTypes: ["TEXT"] },
  { canonicalName: "Updated At", acceptedDataTypes: ["TEXT"] },
];

export const TASK_LEGACY_SPEC_FIELD_NAMES = [
  "Dependencies",
  "Allowed Files",
  "Acceptance Checks",
  "Tests",
  "Non-goals",
  "Commit Units",
  "Acceptance Criteria",
  "RCA / Impact Scope",
] as const;

function normalizeToken(value: string): string {
  return value.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

export function normalizeTaskBoardStatus(value: string): TaskBoardStatus | "" {
  const normalized = normalizeToken(value);
  return (TASK_BOARD_STATUSES.find((status) => status === normalized) ?? "") as
    | TaskBoardStatus
    | "";
}

export function toTaskBoardStatusLabel(
  status: TaskBoardStatus
): "Backlog" | "Ready" | "In progress" | "In review" | "Done" {
  if (status === "backlog") return "Backlog";
  if (status === "ready") return "Ready";
  if (status === "in progress") return "In progress";
  if (status === "in review") return "In review";
  return "Done";
}

export function planTaskBoardStatusReconciliation(input: {
  issueState: "OPEN" | "CLOSED";
  currentStatus: string;
}): TaskStatusReconciliationPlan {
  const status = normalizeTaskBoardStatus(input.currentStatus);
  if (input.issueState === "CLOSED") {
    if (status === "done") {
      return { driftDetected: false, targetStatus: null, reason: "none" };
    }
    return { driftDetected: true, targetStatus: "done", reason: "closed_requires_done" };
  }
  if (status === "done") {
    return {
      driftDetected: true,
      targetStatus: "backlog",
      reason: "open_done_requires_backlog",
    };
  }
  if (!status) {
    return {
      driftDetected: true,
      targetStatus: "backlog",
      reason: "open_invalid_requires_backlog",
    };
  }
  return { driftDetected: false, targetStatus: null, reason: "none" };
}

export function getTaskControlPlaneFieldNames(): string[] {
  return [
    ...TASK_BOARD_FIELD_REQUIREMENTS.map((entry) => entry.canonicalName),
    ...TASK_RUNTIME_FIELD_REQUIREMENTS.map((entry) => entry.canonicalName),
  ];
}

export function buildTaskControlPlaneFieldSchemaReport(
  fields: TaskControlPlaneFieldSchemaEntry[]
): TaskControlPlaneFieldSchemaReport {
  const fieldMap = new Map(
    fields.map((field) => [normalizeToken(field.name), field.dataType.trim().toUpperCase()])
  );
  const invalidDataTypes: TaskControlPlaneInvalidDataType[] = [];
  const missingBoardFields: string[] = [];
  const missingRuntimeFields: string[] = [];

  for (const requirement of TASK_BOARD_FIELD_REQUIREMENTS) {
    const actualDataType = fieldMap.get(normalizeToken(requirement.canonicalName)) || "";
    if (!actualDataType) {
      missingBoardFields.push(requirement.canonicalName);
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

  const legacySpecFieldsPresent = TASK_LEGACY_SPEC_FIELD_NAMES.filter((fieldName) =>
    fieldMap.has(normalizeToken(fieldName))
  );

  return {
    missingBoardFields,
    missingRuntimeFields,
    invalidDataTypes,
    legacySpecFieldsPresent: [...legacySpecFieldsPresent],
  };
}

export function isTaskControlPlaneSchemaSatisfied(
  report: TaskControlPlaneFieldSchemaReport
): boolean {
  return (
    report.missingBoardFields.length === 0 &&
    report.missingRuntimeFields.length === 0 &&
    report.invalidDataTypes.length === 0
  );
}
