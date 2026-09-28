/**
 * Intake triage seam (ENG-25 gate #5).
 * Call on Linear status-change path before enqueue. Soft fail-open → enqueue.
 * Does not own the Phase 1 `queued` comment — callers still post that after enqueue.
 */

import {
  IntakeTriageTimeoutError,
  runIntakeTriageGate,
  type IntakeTriageOutcome,
  type IntakeTriagePassthroughReason,
} from "../../../gateway/jev-router/gates/intake.js";
import type {
  IntakeTriageConfig,
  IntakeTriageLabel,
  IntakeTriageState,
} from "../../../gateway/jev-router/gates/types.js";
import type { JevClient } from "../../../gateway/jev-router/jev-client.js";

export type IntakeTriageAction = "enqueue" | "clarify" | "reject" | "escalate";

/** Mapped decision for Linear / intake callers before enqueue. */
export type IntakeTriageDecision =
  | {
      action: "enqueue";
      source: "intake_triage";
      label: "enqueue";
      confidence: number;
      labels?: string[];
      notes?: string;
    }
  | {
      action: "enqueue";
      source: "passthrough";
      reason: IntakeTriagePassthroughReason;
      confidence?: number;
      message?: string;
      notes?: string;
    }
  | {
      action: "clarify";
      source: "intake_triage";
      label: "clarify";
      confidence: number;
      labels?: string[];
      notes?: string;
    }
  | {
      action: "reject";
      source: "intake_triage";
      label: "reject";
      confidence: number;
      labels?: string[];
      notes?: string;
    }
  | {
      action: "escalate";
      source: "intake_triage";
      reason: "needs_human";
      confidence: number;
      labels?: string[];
      notes?: string;
    };

/** Structured log entry for the feedback loop. */
export interface IntakeTriageLogEntry {
  task_id?: string;
  task_type?: string;
  issue_identifier?: string;
  outcome: IntakeTriageAction | "passthrough" | "error";
  label?: IntakeTriageLabel;
  confidence?: number;
  reason?: IntakeTriagePassthroughReason | "needs_human";
  labels?: string[];
  notes?: string;
  message?: string;
}

export type IntakeTriageLogFn = (entry: IntakeTriageLogEntry) => void;

/**
 * Map an intake triage outcome onto enqueue | clarify | reject | escalate.
 * Soft passthrough → `enqueue` + `source: "passthrough"` (Phase 1 continues).
 * Hard timeout (`kind: "error"`) throws `IntakeTriageTimeoutError`.
 */
export function applyIntakeTriage(outcome: IntakeTriageOutcome): IntakeTriageDecision {
  if (outcome.kind === "error") {
    throw new IntakeTriageTimeoutError(outcome.message);
  }
  if (outcome.kind === "escalate") {
    return {
      action: "escalate",
      source: "intake_triage",
      reason: "needs_human",
      confidence: outcome.confidence,
      ...(outcome.labels !== undefined ? { labels: outcome.labels } : {}),
      ...(outcome.notes !== undefined ? { notes: outcome.notes } : {}),
    };
  }
  if (outcome.kind === "decided") {
    if (outcome.label === "enqueue") {
      return {
        action: "enqueue",
        source: "intake_triage",
        label: "enqueue",
        confidence: outcome.confidence,
        ...(outcome.labels !== undefined ? { labels: outcome.labels } : {}),
        ...(outcome.notes !== undefined ? { notes: outcome.notes } : {}),
      };
    }
    if (outcome.label === "clarify") {
      return {
        action: "clarify",
        source: "intake_triage",
        label: "clarify",
        confidence: outcome.confidence,
        ...(outcome.labels !== undefined ? { labels: outcome.labels } : {}),
        ...(outcome.notes !== undefined ? { notes: outcome.notes } : {}),
      };
    }
    return {
      action: "reject",
      source: "intake_triage",
      label: "reject",
      confidence: outcome.confidence,
      ...(outcome.labels !== undefined ? { labels: outcome.labels } : {}),
      ...(outcome.notes !== undefined ? { notes: outcome.notes } : {}),
    };
  }
  return {
    action: "enqueue",
    source: "passthrough",
    reason: outcome.reason,
    ...(outcome.confidence !== undefined ? { confidence: outcome.confidence } : {}),
    ...(outcome.message !== undefined ? { message: outcome.message } : {}),
    ...(outcome.notes !== undefined ? { notes: outcome.notes } : {}),
  };
}

function taskFields(
  state: IntakeTriageState,
): Pick<IntakeTriageLogEntry, "task_id" | "task_type" | "issue_identifier"> {
  return {
    ...(typeof state.task_id === "string" ? { task_id: state.task_id } : {}),
    ...(typeof state.task_type === "string" ? { task_type: state.task_type } : {}),
    ...(typeof state.issue_identifier === "string"
      ? { issue_identifier: state.issue_identifier }
      : {}),
  };
}

function logEntryFrom(
  state: IntakeTriageState,
  decision: IntakeTriageDecision,
): IntakeTriageLogEntry {
  const base = taskFields(state);
  if (decision.source === "passthrough") {
    return {
      ...base,
      outcome: "passthrough",
      reason: decision.reason,
      ...(decision.confidence !== undefined ? { confidence: decision.confidence } : {}),
      ...(decision.notes !== undefined ? { notes: decision.notes } : {}),
      ...(decision.message !== undefined ? { message: decision.message } : {}),
    };
  }
  if (decision.action === "escalate") {
    return {
      ...base,
      outcome: "escalate",
      label: "needs_human",
      confidence: decision.confidence,
      reason: "needs_human",
      ...(decision.labels !== undefined ? { labels: decision.labels } : {}),
      ...(decision.notes !== undefined ? { notes: decision.notes } : {}),
    };
  }
  return {
    ...base,
    outcome: decision.action,
    label: decision.label,
    confidence: decision.confidence,
    ...(decision.labels !== undefined ? { labels: decision.labels } : {}),
    ...(decision.notes !== undefined ? { notes: decision.notes } : {}),
  };
}

function logHardTimeout(state: IntakeTriageState, message?: string): IntakeTriageLogEntry {
  return {
    ...taskFields(state),
    outcome: "error",
    reason: "timeout",
    ...(message !== undefined ? { message } : {}),
  };
}

/**
 * Run Jev intake triage, map to enqueue/clarify/reject/escalate, log once.
 * Hard timeout still emits `onLog` (`outcome: "error"`) before rethrowing.
 * Soft timeout / transport → `action: "enqueue"` so Phase 1 `queued` still runs.
 */
export async function evaluateIntakeTriageWithGate(input: {
  client: JevClient;
  state: IntakeTriageState;
  config?: Partial<IntakeTriageConfig>;
  onLog?: IntakeTriageLogFn;
}): Promise<IntakeTriageDecision> {
  const outcome = await runIntakeTriageGate({
    client: input.client,
    state: input.state,
    config: input.config,
  });
  try {
    const decision = applyIntakeTriage(outcome);
    input.onLog?.(logEntryFrom(input.state, decision));
    return decision;
  } catch (error) {
    if (error instanceof IntakeTriageTimeoutError) {
      input.onLog?.(logHardTimeout(input.state, error.message));
    }
    throw error;
  }
}

export { IntakeTriageTimeoutError };
