import { loadTaskIssueByTaskIdFromControlPlane as loadTaskIssueByTaskIdFromControlPlaneImpl } from "../adapters/issue-graph-fetch";
import {
  hasActiveForeignClaim as hasActiveForeignClaimImpl,
  loadTaskIssueByTaskId as loadTaskIssueByTaskIdImpl,
  loadTaskIssues as loadTaskIssuesImpl,
  normalizeSourceIssue as normalizeSourceIssueImpl,
  resolveRepository as resolveRepositoryImpl,
  sortIssuesForExecutionPlan as sortIssuesForExecutionPlanImpl,
  validateIssueGraph as validateIssueGraphImpl,
} from "./issue-graph";
import type { GraphIssueNode, TaskIssue, TaskMetadata } from "./issue-graph-types";
import { overlapsPathPattern as overlapsPathPatternImpl } from "./path-patterns";
import { SESSION_ID_PATTERN as SESSION_ID_PATTERN_VALUE } from "./session-id-pattern";
import {
  collectTaskIssueReadAfterWriteMismatches as collectTaskIssueReadAfterWriteMismatchesImpl,
  normalizeIssueBodyForComparison as normalizeIssueBodyForComparisonImpl,
  parseTaskSpec as parseTaskSpecImpl,
  renderIssueBody as renderIssueBodyImpl,
  type TaskSpec,
  tryBuildTaskSpecFromIssueSnapshot as tryBuildTaskSpecFromIssueSnapshotImpl,
} from "./task-issue-contract";
import {
  auditTaskIssueSourceOfTruth as auditTaskIssueSourceOfTruthImpl,
  buildTaskIssueSourceFingerprint as buildTaskIssueSourceFingerprintImpl,
  currentGitBranch as currentGitBranchImpl,
  detectRepositoryFromOrigin as detectRepositoryFromOriginImpl,
  extractTaskIdFromBranch as extractTaskIdFromBranchImpl,
  isTaskIssueSnapshotCurrent as isTaskIssueSnapshotCurrentImpl,
  isVerifiedTaskIssueMarkerCurrent as isVerifiedTaskIssueMarkerCurrentImpl,
  normalizeTaskId as normalizeTaskIdImpl,
  readTaskIssueSnapshot as readTaskIssueSnapshotImpl,
  readVerifiedTaskIssueMarker as readVerifiedTaskIssueMarkerImpl,
  type TaskIssueSnapshot,
  type VerifiedTaskIssueMarker,
  writeTaskIssueSnapshot as writeTaskIssueSnapshotImpl,
  writeVerifiedTaskIssueMarker as writeVerifiedTaskIssueMarkerImpl,
} from "./task-issue-guard";
import {
  buildTaskScopeManifestFromTaskIssue as buildTaskScopeManifestFromTaskIssueImpl,
  collectManifestConflicts as collectManifestConflictsImpl,
  materializeTaskScopeManifestForTaskIssue as materializeTaskScopeManifestForTaskIssueImpl,
  runTaskScopeCli as runTaskScopeCliImpl,
} from "./task-scope";
import {
  collectTaskSizingFindings as collectTaskSizingFindingsImpl,
  findForbiddenDesignDeferralLabels as findForbiddenDesignDeferralLabelsImpl,
} from "./task-sizing";
import {
  analyzeTaskSizingBackfill as analyzeTaskSizingBackfillImpl,
  buildTaskSizingBackfillLinkedChildTaskCountMap as buildTaskSizingBackfillLinkedChildTaskCountMapImpl,
  collectTaskSizingBackfillReport as collectTaskSizingBackfillReportImpl,
  type TaskSizingBackfillAnalysis,
  type TaskSizingBackfillReport,
} from "./task-sizing-backfill";
import {
  collectTaskSizingCertificationReport as collectTaskSizingCertificationReportImpl,
  type TaskSizingCertificationFailure,
  type TaskSizingCertificationReport,
} from "./task-sizing-certification";

export type {
  GraphIssueNode,
  TaskIssue,
  TaskIssueSnapshot,
  TaskMetadata,
  TaskSizingBackfillAnalysis,
  TaskSizingBackfillReport,
  TaskSizingCertificationFailure,
  TaskSizingCertificationReport,
  TaskSpec,
  VerifiedTaskIssueMarker,
};

export const SESSION_ID_PATTERN = SESSION_ID_PATTERN_VALUE;
export const analyzeTaskSizingBackfill = analyzeTaskSizingBackfillImpl;
export const auditTaskIssueSourceOfTruth = auditTaskIssueSourceOfTruthImpl;
export const buildTaskIssueSourceFingerprint = buildTaskIssueSourceFingerprintImpl;
export const buildTaskScopeManifestFromTaskIssue = buildTaskScopeManifestFromTaskIssueImpl;
export const buildTaskSizingBackfillLinkedChildTaskCountMap =
  buildTaskSizingBackfillLinkedChildTaskCountMapImpl;
export const collectManifestConflicts = collectManifestConflictsImpl;
export const collectTaskIssueReadAfterWriteMismatches =
  collectTaskIssueReadAfterWriteMismatchesImpl;
export const collectTaskSizingBackfillReport = collectTaskSizingBackfillReportImpl;
export const collectTaskSizingCertificationReport = collectTaskSizingCertificationReportImpl;
export const collectTaskSizingFindings = collectTaskSizingFindingsImpl;
export const currentGitBranch = currentGitBranchImpl;
export const detectRepositoryFromOrigin = detectRepositoryFromOriginImpl;
export const extractTaskIdFromBranch = extractTaskIdFromBranchImpl;
export const findForbiddenDesignDeferralLabels = findForbiddenDesignDeferralLabelsImpl;
export const hasActiveForeignClaim = hasActiveForeignClaimImpl;
export const isTaskIssueSnapshotCurrent = isTaskIssueSnapshotCurrentImpl;
export const isVerifiedTaskIssueMarkerCurrent = isVerifiedTaskIssueMarkerCurrentImpl;
export const loadTaskIssueByTaskId = loadTaskIssueByTaskIdImpl;
export const loadTaskIssueByTaskIdFromControlPlane = loadTaskIssueByTaskIdFromControlPlaneImpl;
export const loadTaskIssues = loadTaskIssuesImpl;
export const materializeTaskScopeManifestForTaskIssue =
  materializeTaskScopeManifestForTaskIssueImpl;
export const normalizeIssueBodyForComparison = normalizeIssueBodyForComparisonImpl;
export const normalizeSourceIssue = normalizeSourceIssueImpl;
export const normalizeTaskId = normalizeTaskIdImpl;
export const overlapsPathPattern = overlapsPathPatternImpl;
export const parseTaskSpec = parseTaskSpecImpl;
export const readTaskIssueSnapshot = readTaskIssueSnapshotImpl;
export const readVerifiedTaskIssueMarker = readVerifiedTaskIssueMarkerImpl;
export const renderIssueBody = renderIssueBodyImpl;
export const resolveRepository = resolveRepositoryImpl;
export const runTaskScopeCli = runTaskScopeCliImpl;
export const sortIssuesForExecutionPlan = sortIssuesForExecutionPlanImpl;
export const tryBuildTaskSpecFromIssueSnapshot = tryBuildTaskSpecFromIssueSnapshotImpl;
export const validateIssueGraph = validateIssueGraphImpl;
export const writeTaskIssueSnapshot = writeTaskIssueSnapshotImpl;
export const writeVerifiedTaskIssueMarker = writeVerifiedTaskIssueMarkerImpl;
