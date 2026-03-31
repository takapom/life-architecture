import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import { normalizeTmuxSessionName } from "../orchestrator-tmux";
import {
  type OrchestrationNodeStatusSummary,
  type OrchestrationReviewMode,
  type OrchestrationSessionControlPlaneAction,
  summarizeOrchestrationSessionControlPlane,
} from "../runtime/orchestration-session-control-plane";
import {
  type RuntimeLifecycleCommandRecord,
  type RuntimeLifecycleStatus,
  summarizeRuntimeLifecycle,
} from "./runtime_lifecycle";
import { resolveSessionArtifactPaths } from "./session_artifacts";

export type OperatorStatus = {
  session_id: string;
  state_dir: string;
  runtime_status: RuntimeLifecycleStatus;
  tmux_session: string;
  tmux_session_present: boolean;
  review_mode: OrchestrationReviewMode;
  overall_status: "active" | "blocked" | "ready_for_close" | "closed";
  active_nodes: OrchestrationNodeStatusSummary[];
  blocked_nodes: OrchestrationNodeStatusSummary[];
  ready_for_review_nodes: string[];
  next_actions: string[];
  followup_count: number;
  residue_nodes: string[];
  session_lock: {
    owner_label: string;
    updated_at: string;
  } | null;
  last_event: {
    sequence: number;
    event_type: string;
    recorded_at: string;
  } | null;
  last_command: RuntimeLifecycleCommandRecord | null;
};

function readJsonIfExists(filePath: string): unknown {
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
}

function hasTmuxSession(repoRoot: string, sessionName: string): boolean {
  const result = spawnSync("tmux", ["has-session", "-t", sessionName], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.status === 0;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function renderControlPlaneAction(
  action: OrchestrationSessionControlPlaneAction,
  summary: ReturnType<typeof summarizeOrchestrationSessionControlPlane>
): string {
  switch (action.kind) {
    case "review_ready_nodes":
      return summary.review_mode === "auto"
        ? `Monitor auto-review nodes: ${summary.ready_for_review_nodes.join(", ")}`
        : `Review nodes: ${summary.ready_for_review_nodes.join(", ")}`;
    case "monitor_active_nodes":
      return `Monitor active nodes: ${summary.active_nodes.map((node) => node.node_id).join(", ")}`;
    case "resolve_blocked_nodes":
      return `Resolve blocked nodes: ${summary.blocked_nodes.map((node) => `${node.node_id}${node.blocked_reason ? `(${node.blocked_reason})` : ""}`).join(", ")}`;
    case "run_close":
      return `Run close for session ${summary.session_id}`;
    case "create_followups":
      return "Create follow-up tasks from followup-drafts.json";
    case "closeout_message":
      return action.message;
  }
}

export function summarizeOperatorStatus(options: {
  repoRoot: string;
  sessionId: string;
  stateDir: string;
  tmuxSessionOverride?: string;
}): OperatorStatus {
  const paths = resolveSessionArtifactPaths(options.stateDir);
  const runtime = summarizeRuntimeLifecycle({
    stateDir: options.stateDir,
    sessionId: options.sessionId,
  });
  const tmuxSession = normalizeTmuxSessionName(
    options.sessionId,
    options.tmuxSessionOverride || ""
  );
  const tmuxSessionPresent = hasTmuxSession(options.repoRoot, tmuxSession);
  const summary = summarizeOrchestrationSessionControlPlane({
    sessionId: options.sessionId,
    state: readJsonIfExists(paths.stateJson),
    gateResults: readJsonIfExists(paths.gateResultsJson),
    closeoutSummary: readJsonIfExists(paths.closeoutSummaryJson),
    followupDrafts: readJsonIfExists(paths.followupDraftsJson),
  });
  const nextActions = summary.recommended_actions.map((action) =>
    renderControlPlaneAction(action, summary)
  );
  if (summary.active_nodes.length > 0) {
    nextActions.push(
      tmuxSessionPresent
        ? `Attach tmux viewport ${tmuxSession}`
        : `Prepare or attach tmux viewport ${tmuxSession}`
    );
  }
  if (runtime.lock) {
    nextActions.push(`Session lock held by ${runtime.lock.owner_label}`);
  }

  return {
    session_id: options.sessionId,
    state_dir: options.stateDir,
    runtime_status: runtime.status,
    tmux_session: tmuxSession,
    tmux_session_present: tmuxSessionPresent,
    review_mode: summary.review_mode,
    overall_status: summary.overall_status,
    active_nodes: summary.active_nodes,
    blocked_nodes: summary.blocked_nodes,
    ready_for_review_nodes: summary.ready_for_review_nodes,
    next_actions: uniqueStrings(nextActions),
    followup_count: summary.followup_count,
    residue_nodes: summary.residue_nodes,
    session_lock: runtime.lock
      ? {
          owner_label: runtime.lock.owner_label,
          updated_at: runtime.lock.updated_at,
        }
      : null,
    last_event: runtime.last_event
      ? {
          sequence: runtime.last_event.sequence,
          event_type: runtime.last_event.event_type,
          recorded_at: runtime.last_event.recorded_at,
        }
      : null,
    last_command: runtime.last_command,
  };
}
