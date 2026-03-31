import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { isObject, nowIsoUtc, parseJson } from "./common";
import {
  type GateResultsPayload,
  type JsonObject,
  type ResidueItem,
  type ReviewArtifact,
  type ReviewFinding,
  type StatePayload,
  TERMINAL_STATUSES,
} from "./contracts";

function normalizeReviewDecision(value: string): string {
  const decision = value.trim().toLowerCase();
  if (decision === "approve" || decision === "rework" || decision === "reject") {
    return decision;
  }
  return "";
}

function normalizeReviewArtifact(value: unknown): ReviewArtifact | null {
  if (!isObject(value)) return null;
  const findingsRaw = Array.isArray(value.findings) ? value.findings : [];
  const findings: ReviewFinding[] = findingsRaw
    .filter((entry) => isObject(entry))
    .map((entry) => {
      const finding: ReviewFinding = {
        severity: String(entry.severity || "medium").trim() || "medium",
        category: String(entry.category || "review").trim() || "review",
        summary: String(entry.summary || "").trim(),
      };
      const findingPath = String(entry.path || "").trim();
      if (findingPath) finding.path = findingPath;
      const line = Number(entry.line || 0);
      if (Number.isInteger(line) && line > 0) finding.line = line;
      return finding;
    })
    .filter((entry) => entry.summary.length > 0);
  const escalation = isObject(value.escalation) ? value.escalation : {};
  return {
    decision: normalizeReviewDecision(String(value.decision || "")),
    summary: String(value.summary || value.notes || "").trim(),
    findings,
    escalation: {
      level: String(escalation.level || "none").trim() || "none",
      reason: String(escalation.reason || "").trim(),
    },
  };
}

export function validateCloseState(
  state: StatePayload,
  gate: GateResultsPayload,
  options: {
    requireBranch?: boolean;
  } = {}
): string[] {
  const errors: string[] = [];
  const requireBranch = options.requireBranch !== false;

  const gateByNode = new Map(gate.nodes.map((node) => [node.node_id, node]));

  for (const [nodeId, node] of Object.entries(state.nodes)) {
    if (!node.status) {
      errors.push(`node ${nodeId}: status is required`);
      continue;
    }
    if (!TERMINAL_STATUSES.has(node.status)) {
      errors.push(`node ${nodeId}: non-terminal status '${node.status}'`);
    }
    if (requireBranch && !node.branch) {
      errors.push(`node ${nodeId}: branch is required`);
    }

    if (!gateByNode.has(nodeId)) {
      errors.push(`node ${nodeId}: missing gate-results entry`);
    }
  }

  return errors;
}

export function readStatusFiles(stateDir: string): Record<string, JsonObject> {
  const statusDir = path.join(stateDir, "status");
  if (!existsSync(statusDir)) {
    return {};
  }

  const files = readdirSync(statusDir).filter((name) => name.endsWith(".json"));
  const out: Record<string, JsonObject> = {};

  for (const fileName of files) {
    const nodeId = fileName.replace(/\.json$/, "").trim();
    if (!nodeId) continue;

    const fullPath = path.join(statusDir, fileName);
    const parsed = parseJson(readFileSync(fullPath, "utf8"), fullPath);
    out[nodeId] = isObject(parsed) ? parsed : {};
  }

  return out;
}

export function readReviewFiles(stateDir: string): Record<string, ReviewArtifact> {
  const reviewDir = path.join(stateDir, "review");
  if (!existsSync(reviewDir)) {
    return {};
  }

  const files = readdirSync(reviewDir).filter((name) => name.endsWith(".json"));
  const out: Record<string, ReviewArtifact> = {};

  for (const fileName of files) {
    const nodeId = fileName.replace(/\.json$/, "").trim();
    if (!nodeId) continue;

    const fullPath = path.join(reviewDir, fileName);
    const parsed = normalizeReviewArtifact(parseJson(readFileSync(fullPath, "utf8"), fullPath));
    if (!parsed) continue;
    out[nodeId] = parsed;
  }

  return out;
}

export function extractResidueNodes(
  state: StatePayload,
  gate: GateResultsPayload,
  statusFiles: Record<string, JsonObject>,
  reviewFiles: Record<string, ReviewArtifact> = {}
): ResidueItem[] {
  const gateByNode = new Map(gate.nodes.map((entry) => [entry.node_id, entry]));
  const residues: ResidueItem[] = [];

  for (const [nodeId, node] of Object.entries(state.nodes)) {
    if (node.status === "done" || node.status === "merged") {
      continue;
    }

    const gateEntry = gateByNode.get(nodeId);
    const statusPayload = statusFiles[nodeId] || {};
    const reviewPayload = reviewFiles[nodeId];
    const reviewDecision = reviewPayload?.decision || "";
    const reviewSummary = reviewPayload?.summary || "";
    const reviewEscalation = reviewPayload?.escalation || { level: "none", reason: "" };
    const reviewFindings = reviewPayload?.findings || [];
    const summary =
      gateEntry?.summary ||
      String(statusPayload.summary || "").trim() ||
      (node.status === "ready_for_review" && !reviewDecision
        ? "waiting for reviewer-lane artifact"
        : reviewSummary) ||
      "close phase detected non-done terminal state";
    const failureReason =
      gateEntry?.failure_reason ||
      String(statusPayload.failure_reason || "").trim() ||
      (reviewDecision === "reject" ? "review_rejected" : "");

    residues.push({
      node_id: nodeId,
      status: gateEntry?.status || node.status,
      branch: gateEntry?.branch || node.branch,
      summary,
      failure_reason: failureReason,
      pr_url: gateEntry?.pr_url || String(statusPayload.pr_url || "").trim() || "",
      review_decision: reviewDecision,
      review_summary: reviewSummary,
      review_findings: reviewFindings,
      review_escalation: {
        level: reviewEscalation.level || "none",
        reason: reviewEscalation.reason || "",
      },
    });
  }

  return residues.sort((left, right) => left.node_id.localeCompare(right.node_id));
}

export function buildFollowupDrafts(residues: ResidueItem[]): JsonObject {
  return {
    generated_at: nowIsoUtc(),
    count: residues.length,
    items: residues.map((item) => ({
      source_node_id: item.node_id,
      source_branch: item.branch,
      source_status: item.status,
      source_failure_reason: item.failure_reason,
      source_pr_url: item.pr_url,
      suggested_task_type: "ops",
      suggested_status: "backlog",
      suggested_priority: 80,
      suggested_summary: `Re-implement ${item.node_id} from orchestrate-close residue (${item.status})`,
      suggested_acceptance_criteria: [
        "Root cause of the residue is identified and fixed",
        "Failed/blocked checks are made reproducible and passing",
        "Close phase residue report no longer includes this node",
      ],
      notes: item.summary,
      review: {
        decision: item.review_decision,
        summary: item.review_summary,
        findings: item.review_findings,
        escalation: item.review_escalation,
      },
    })),
  };
}
