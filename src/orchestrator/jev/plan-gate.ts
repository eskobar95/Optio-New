/**
 * Opt-in plan / spec gate seam (ENG-25 gate #2).
 * Call after planner / before implement. Not wired into processStageJob by default.
 *
 * Continue to implement when `action === "proceed"` (auto_clear **or** soft passthrough).
 * Soft fail-open maps to `proceed` + `source: "passthrough"` so callers never stall on transport/low confidence.
 */

import {
  PlanGateTimeoutError,
  runPlanGate,
  type PlanGateOutcome,
  type PlanGatePassthroughReason,
} from "../../../gateway/jev-router/gates/plan.js";
import type {
  PlanGateConfig,
  PlanGateLabel,
  PlanGateState,
} from "../../../gateway/jev-router/gates/types.js";
import type { JevClient } from "../../../gateway/jev-router/jev-client.js";

export type PlanGateAction = "proceed" | "revise" | "escalate";

/** Mapped decision for orchestrator callers after plan stage. */
export type PlanGateDecision =
  | {
      action: "proceed";
      source: "plan_gate";
      label: "auto_clear";
      confidence: number;
      notes?: string;
    }
  | {
      action: "proceed";
      source: "passthrough";
      reason: PlanGatePassthroughReason;
      confidence?: number;
      message?: string;
      notes?: string;
    }
  | {
      action: "revise";
      source: "plan_gate";
      label: "needs_revision";
      confidence: number;
      notes?: string;
    }
  | {
      action: "escalate";
      source: "plan_gate";
      reason: "needs_human";
      confidence: number;
      notes?: string;
    };

/** Structured log entry for the feedback loop (task type + outcome). */
export interface PlanGateLogEntry {
  task_type?: string;
  /** Gate/signal outcome: decided actions, soft `passthrough`, or hard `error`. */
  outcome: PlanGateAction | "passthrough" | "error";
  label?: PlanGateLabel;
  confidence?: number;
  reason?: PlanGatePassthroughReason | "needs_human";
  notes?: string;
  message?: string;
}

export type PlanGateLogFn = (entry: PlanGateLogEntry) => void;

/**
 * Map a plan gate outcome onto proceed | revise | escalate.
 * Soft passthrough → `proceed` + `source: "passthrough"` (continue to implement).
 * Hard timeout (`kind: "error"`) throws `PlanGateTimeoutError`.
 */
export function applyPlanGate(outcome: PlanGateOutcome): PlanGateDecision {
  if (outcome.kind === "error") {
    throw new PlanGateTimeoutError(outcome.message);
  }
  if (outcome.kind === "escalate") {
    return {
      action: "escalate",
      source: "plan_gate",
      reason: "needs_human",
      confidence: outcome.confidence,
      ...(outcome.notes !== undefined ? { notes: outcome.notes } : {}),
    };
  }
  if (outcome.kind === "decided") {
    if (outcome.label === "auto_clear") {
      return {
        action: "proceed",
        source: "plan_gate",
        label: "auto_clear",
        confidence: outcome.confidence,
        ...(outcome.notes !== undefined ? { notes: outcome.notes } : {}),
      };
    }
    return {
      action: "revise",
      source: "plan_gate",
      label: "needs_revision",
      confidence: outcome.confidence,
      ...(outcome.notes !== undefined ? { notes: outcome.notes } : {}),
    };
  }
  return {
    action: "proceed",
    source: "passthrough",
    reason: outcome.reason,
    ...(outcome.confidence !== undefined ? { confidence: outcome.confidence } : {}),
    ...(outcome.message !== undefined ? { message: outcome.message } : {}),
    ...(outcome.notes !== undefined ? { notes: outcome.notes } : {}),
  };
}

function taskTypeField(state: PlanGateState): Pick<PlanGateLogEntry, "task_type"> {
  return typeof state.task_type === "string" ? { task_type: state.task_type } : {};
}

function logEntryFrom(state: PlanGateState, decision: PlanGateDecision): PlanGateLogEntry {
  const base = taskTypeField(state);
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
  if (decision.action === "proceed") {
    return {
      ...base,
      outcome: "proceed",
      label: decision.label,
      confidence: decision.confidence,
      ...(decision.notes !== undefined ? { notes: decision.notes } : {}),
    };
  }
  if (decision.action === "revise") {
    return {
      ...base,
      outcome: "revise",
      label: decision.label,
      confidence: decision.confidence,
      ...(decision.notes !== undefined ? { notes: decision.notes } : {}),
    };
  }
  return {
    ...base,
    outcome: "escalate",
    label: "needs_human",
    confidence: decision.confidence,
    reason: "needs_human",
    ...(decision.notes !== undefined ? { notes: decision.notes } : {}),
  };
}

function logHardTimeout(state: PlanGateState, message?: string): PlanGateLogEntry {
  return {
    ...taskTypeField(state),
    outcome: "error",
    reason: "timeout",
    ...(message !== undefined ? { message } : {}),
  };
}

/**
 * Opt-in path: run Jev plan gate, map to orchestrator action, log once for feedback.
 * Hard timeout still emits `onLog` (`outcome: "error"`) before rethrowing.
 */
export async function evaluatePlanWithGate(input: {
  client: JevClient;
  state: PlanGateState;
  config?: Partial<PlanGateConfig>;
  onLog?: PlanGateLogFn;
}): Promise<PlanGateDecision> {
  const outcome = await runPlanGate({
    client: input.client,
    state: input.state,
    config: input.config,
  });
  try {
    const decision = applyPlanGate(outcome);
    input.onLog?.(logEntryFrom(input.state, decision));
    return decision;
  } catch (error) {
    if (error instanceof PlanGateTimeoutError) {
      input.onLog?.(logHardTimeout(input.state, error.message));
    }
    throw error;
  }
}

export { PlanGateTimeoutError };
