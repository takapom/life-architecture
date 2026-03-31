// Canonical issue-graph barrel for orchestration/task tooling.

import { loadTaskIssueByTaskId, loadTaskIssues } from "../adapters/issue-graph-fetch";

export { loadTaskIssueByTaskId, loadTaskIssues };

import type {
  AdmissionConflict,
  GraphIssueNode,
  IssueState,
  RepositoryRef,
  TaskIssue,
  TaskMetadata,
  ValidationResult,
} from "./issue-graph-types";
import {
  assertNoRetiredProjectNumberEnv,
  extractIssueNumbers,
  extractLabels,
  hasActiveForeignClaim,
  normalizePathPattern,
  normalizeSourceIssue,
  parseIssueState,
  parseTaskMetadata,
  resolveExpectedProjectNumber,
  resolveGitHubToken,
  resolveRepository,
  TASK_ID_PATTERN,
  VALID_STATUSES,
  VALID_TYPES,
} from "./issue-graph-types";

export type {
  AdmissionConflict,
  GraphIssueNode,
  IssueState,
  RepositoryRef,
  TaskIssue,
  TaskMetadata,
  ValidationResult,
};
export {
  assertNoRetiredProjectNumberEnv,
  extractIssueNumbers,
  extractLabels,
  hasActiveForeignClaim,
  normalizePathPattern,
  normalizeSourceIssue,
  parseIssueState,
  parseTaskMetadata,
  resolveExpectedProjectNumber,
  resolveGitHubToken,
  resolveRepository,
  TASK_ID_PATTERN,
  VALID_STATUSES,
  VALID_TYPES,
};

import { sortIssuesForExecutionPlan, validateIssueGraph } from "./issue-graph-validate";
import { globPrefix, overlapsPathPattern } from "./path-patterns";

export { globPrefix, overlapsPathPattern, sortIssuesForExecutionPlan, validateIssueGraph };
