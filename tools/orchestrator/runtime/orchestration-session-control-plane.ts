import {
  parseSessionStateArtifact,
  readSessionArtifactSnapshot,
  type SessionArtifactSnapshot,
} from "../shared/session_state";

export type OrchestrationReviewMode = "auto" | "manual";

export type OrchestrationNodeStatusSummary = {
  node_id: string;
  status: string;
  branch: string;
  owner: string;
  blocked_reason: string;
  summary: string;
};

export type OrchestrationSessionControlPlaneAction =
  | { kind: "review_ready_nodes" }
  | { kind: "monitor_active_nodes" }
  | { kind: "resolve_blocked_nodes" }
  | { kind: "run_close" }
  | { kind: "create_followups" }
  | { kind: "closeout_message"; message: string };

export type OrchestrationSessionControlPlaneSummary = {
  session_id: string;
  review_mode: OrchestrationReviewMode;
  overall_status: "active" | "blocked" | "ready_for_close" | "closed";
  active_nodes: OrchestrationNodeStatusSummary[];
  blocked_nodes: OrchestrationNodeStatusSummary[];
  ready_for_review_nodes: string[];
  recommended_actions: OrchestrationSessionControlPlaneAction[];
  followup_count: number;
  residue_nodes: string[];
};

function fail(message: string): never {
  throw new Error(message);
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function uniqueCloseoutMessages(
  actions: OrchestrationSessionControlPlaneAction[]
): OrchestrationSessionControlPlaneAction[] {
  const seen = new Set<string>();
  const deduped: OrchestrationSessionControlPlaneAction[] = [];
  for (const action of actions) {
    if (action.kind !== "closeout_message") {
      deduped.push(action);
      continue;
    }
    const message = action.message.trim();
    if (!message || seen.has(message)) continue;
    seen.add(message);
    deduped.push({ kind: "closeout_message", message });
  }
  return deduped;
}

export function readOrchestrationReviewMode(gateRaw: unknown): OrchestrationReviewMode {
  if (
    !isObject(gateRaw) ||
    !isObject(gateRaw.dispatch) ||
    !isObject(gateRaw.dispatch.review_policy)
  ) {
    fail("invalid or missing gate-results.json dispatch.review_policy");
  }
  const { review_policy: reviewPolicy } = gateRaw.dispatch;
  const mode = reviewPolicy.mode;
  const autoApprove = reviewPolicy.auto_approve;
  if (mode !== "auto" && mode !== "manual") {
    fail("invalid gate-results.json dispatch.review_policy.mode");
  }
  if (typeof autoApprove !== "boolean") {
    fail("invalid gate-results.json dispatch.review_policy.auto_approve");
  }
  const inferredMode: OrchestrationReviewMode = autoApprove ? "auto" : "manual";
  if (mode !== inferredMode) {
    fail("inconsistent gate-results.json dispatch.review_policy");
  }
  return mode;
}

export function summarizeOrchestrationSessionControlPlane(input: {
  sessionId: string;
  state: unknown;
  gateResults: unknown;
  closeoutSummary?: unknown;
  followupDrafts?: unknown;
}): OrchestrationSessionControlPlaneSummary {
  const stateArtifact = parseSessionStateArtifact(input.state, "state.json");

  const reviewMode = readOrchestrationReviewMode(input.gateResults);
  const gateRaw = isObject(input.gateResults) ? input.gateResults : {};
  const gateNodes = Array.isArray(gateRaw.nodes) ? gateRaw.nodes : [];
  const gateByNode = new Map<string, JsonObject>();
  for (const entry of gateNodes) {
    if (!isObject(entry)) continue;
    const nodeId = String(entry.node_id || "").trim();
    if (!nodeId) continue;
    gateByNode.set(nodeId, entry);
  }

  const activeStatuses = new Set(["queued", "running", "ready_for_review", "merging"]);
  const activeNodes: OrchestrationNodeStatusSummary[] = [];
  const blockedNodes: OrchestrationNodeStatusSummary[] = [];
  const readyForReviewNodes: string[] = [];

  for (const [nodeId, rawNode] of Object.entries(stateArtifact.nodes)) {
    const status = String(rawNode.status || "")
      .trim()
      .toLowerCase();
    const gate = gateByNode.get(nodeId) || {};
    const summary = String(gate.summary || rawNode.last_failure_summary || "").trim();
    const blockedReason = String(
      gate.failure_reason || rawNode.blocked_reason || rawNode.last_failure_reason || ""
    ).trim();
    const nodeSummary: OrchestrationNodeStatusSummary = {
      node_id: nodeId,
      status,
      branch: String(rawNode.branch || "").trim(),
      owner: String(rawNode.claim_owner || rawNode.claimed_by || "").trim(),
      blocked_reason: blockedReason,
      summary,
    };

    if (activeStatuses.has(status)) {
      activeNodes.push(nodeSummary);
    }
    if (status === "ready_for_review") {
      readyForReviewNodes.push(nodeId);
    }
    if (status === "blocked" || status === "failed") {
      blockedNodes.push(nodeSummary);
    }
  }

  activeNodes.sort((a, b) => a.node_id.localeCompare(b.node_id));
  blockedNodes.sort((a, b) => a.node_id.localeCompare(b.node_id));
  readyForReviewNodes.sort((a, b) => a.localeCompare(b));

  const closeout = isObject(input.closeoutSummary) ? input.closeoutSummary : {};
  const followup = isObject(input.followupDrafts) ? input.followupDrafts : {};
  const residueNodes = Array.isArray(closeout.residue_nodes)
    ? closeout.residue_nodes.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
  const followupItems = Array.isArray(followup.items) ? followup.items : [];
  const followupCount = Number.isInteger(followup.count)
    ? Number(followup.count)
    : followupItems.length;
  const hasCloseoutSummary = isObject(input.closeoutSummary);

  let overallStatus: OrchestrationSessionControlPlaneSummary["overall_status"] = "ready_for_close";
  if (hasCloseoutSummary) overallStatus = "closed";
  if (activeNodes.length > 0) overallStatus = "active";
  if (blockedNodes.length > 0) overallStatus = "blocked";

  const recommendedActions: OrchestrationSessionControlPlaneAction[] = [];
  if (readyForReviewNodes.length > 0) {
    recommendedActions.push({ kind: "review_ready_nodes" });
  }
  if (activeNodes.length > 0 && readyForReviewNodes.length === 0) {
    recommendedActions.push({ kind: "monitor_active_nodes" });
  }
  if (blockedNodes.length > 0) {
    recommendedActions.push({ kind: "resolve_blocked_nodes" });
  }
  if (
    !hasCloseoutSummary &&
    activeNodes.length === 0 &&
    (overallStatus === "ready_for_close" || overallStatus === "blocked")
  ) {
    recommendedActions.push({ kind: "run_close" });
  }
  if (followupCount > 0) {
    recommendedActions.push({ kind: "create_followups" });
  }
  if (Array.isArray(closeout.next_actions)) {
    recommendedActions.push(
      ...closeout.next_actions
        .map((value) => String(value || "").trim())
        .filter(Boolean)
        .map(
          (message) =>
            ({ kind: "closeout_message", message }) satisfies OrchestrationSessionControlPlaneAction
        )
    );
  }

  return {
    session_id: input.sessionId,
    review_mode: reviewMode,
    overall_status: overallStatus,
    active_nodes: activeNodes,
    blocked_nodes: blockedNodes,
    ready_for_review_nodes: readyForReviewNodes,
    recommended_actions: uniqueCloseoutMessages(recommendedActions),
    followup_count: followupCount,
    residue_nodes: residueNodes,
  };
}

export function summarizeOrchestrationSessionControlPlaneFromSnapshot(input: {
  sessionId: string;
  snapshot: Pick<
    SessionArtifactSnapshot,
    "state" | "gate_results" | "closeout_summary" | "followup_drafts"
  >;
}): OrchestrationSessionControlPlaneSummary {
  if (!input.snapshot.state) {
    fail("missing state.json session artifact");
  }
  return summarizeOrchestrationSessionControlPlane({
    sessionId: input.sessionId,
    state: input.snapshot.state.raw,
    gateResults: input.snapshot.gate_results,
    closeoutSummary: input.snapshot.closeout_summary,
    followupDrafts: input.snapshot.followup_drafts,
  });
}

export function summarizeOrchestrationSessionControlPlaneFromStateDir(input: {
  stateDir: string;
  sessionId: string;
}): OrchestrationSessionControlPlaneSummary {
  return summarizeOrchestrationSessionControlPlaneFromSnapshot({
    sessionId: input.sessionId,
    snapshot: readSessionArtifactSnapshot(input.stateDir),
  });
}
