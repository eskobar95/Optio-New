/**
 * Review pre-screen seam (ENG-25 gate #4).
 * Call before Hannes / review-agent dispatch. Soft fail-open → forward all paths.
 */

import {
  ReviewPrescreenTimeoutError,
  runReviewPrescreenGate,
  type ReviewPrescreenOutcome,
  type ReviewPrescreenPassthroughReason,
} from "../../../gateway/jev-router/gates/review-prescreen.js";
import type {
  ReviewPrescreenConfig,
  ReviewPrescreenLabel,
  ReviewPrescreenState,
} from "../../../gateway/jev-router/gates/types.js";
import type { JevClient } from "../../../gateway/jev-router/jev-client.js";

export type ReviewPrescreenAction = "forward" | "filter" | "escalate";

/** Mapped decision for callers before Hannes dispatch. */
export type ReviewPrescreenDecision =
  | {
      action: "forward";
      source: "review_prescreen";
      label: "forward";
      confidence: number;
      paths: string[];
      notes?: string;
    }
  | {
      action: "filter";
      source: "review_prescreen";
      label: "filter";
      confidence: number;
      paths: string[];
      notes?: string;
    }
  | {
      action: "forward";
      source: "passthrough";
      reason: ReviewPrescreenPassthroughReason;
      paths: string[];
      confidence?: number;
      message?: string;
      notes?: string;
    }
  | {
      action: "escalate";
      source: "review_prescreen";
      reason: "needs_human";
      confidence: number;
      paths: string[];
      notes?: string;
    };

/** Structured log entry for the feedback loop. */
export interface ReviewPrescreenLogEntry {
  task_id?: string;
  task_type?: string;
  outcome: ReviewPrescreenAction | "passthrough" | "error";
  label?: ReviewPrescreenLabel;
  confidence?: number;
  reason?: ReviewPrescreenPassthroughReason | "needs_human";
  paths?: string[];
  notes?: string;
  message?: string;
}

export type ReviewPrescreenLogFn = (entry: ReviewPrescreenLogEntry) => void;

/**
 * Map a review pre-screen outcome onto forward | filter | escalate.
 * Soft passthrough → `forward` + `source: "passthrough"` (full path set).
 * Hard timeout (`kind: "error"`) throws `ReviewPrescreenTimeoutError`.
 */
export function applyReviewPrescreen(
  outcome: ReviewPrescreenOutcome,
  allPaths: readonly string[],
): ReviewPrescreenDecision {
  const paths = [...allPaths];
  if (outcome.kind === "error") {
    throw new ReviewPrescreenTimeoutError(outcome.message);
  }
  if (outcome.kind === "escalate") {
    return {
      action: "escalate",
      source: "review_prescreen",
      reason: "needs_human",
      confidence: outcome.confidence,
      paths,
      ...(outcome.notes !== undefined ? { notes: outcome.notes } : {}),
    };
  }
  if (outcome.kind === "decided") {
    if (outcome.label === "filter") {
      return {
        action: "filter",
        source: "review_prescreen",
        label: "filter",
        confidence: outcome.confidence,
        paths: outcome.filteredPaths ?? [],
        ...(outcome.notes !== undefined ? { notes: outcome.notes } : {}),
      };
    }
    return {
      action: "forward",
      source: "review_prescreen",
      label: "forward",
      confidence: outcome.confidence,
      paths,
      ...(outcome.notes !== undefined ? { notes: outcome.notes } : {}),
    };
  }
  return {
    action: "forward",
    source: "passthrough",
    reason: outcome.reason,
    paths,
    ...(outcome.confidence !== undefined ? { confidence: outcome.confidence } : {}),
    ...(outcome.message !== undefined ? { message: outcome.message } : {}),
    ...(outcome.notes !== undefined ? { notes: outcome.notes } : {}),
  };
}

function taskFields(
  state: ReviewPrescreenState,
): Pick<ReviewPrescreenLogEntry, "task_id" | "task_type"> {
  return {
    ...(typeof state.task_id === "string" ? { task_id: state.task_id } : {}),
    ...(typeof state.task_type === "string" ? { task_type: state.task_type } : {}),
  };
}

function logEntryFrom(
  state: ReviewPrescreenState,
  decision: ReviewPrescreenDecision,
): ReviewPrescreenLogEntry {
  const base = taskFields(state);
  if (decision.source === "passthrough") {
    return {
      ...base,
      outcome: "passthrough",
      reason: decision.reason,
      paths: decision.paths,
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
      paths: decision.paths,
      ...(decision.notes !== undefined ? { notes: decision.notes } : {}),
    };
  }
  return {
    ...base,
    outcome: decision.action,
    label: decision.label,
    confidence: decision.confidence,
    paths: decision.paths,
    ...(decision.notes !== undefined ? { notes: decision.notes } : {}),
  };
}

function logHardTimeout(state: ReviewPrescreenState, message?: string): ReviewPrescreenLogEntry {
  return {
    ...taskFields(state),
    outcome: "error",
    reason: "timeout",
    ...(message !== undefined ? { message } : {}),
  };
}

/**
 * Opt-in path: run Jev review pre-screen, map to forward/filter/escalate, log once.
 * Hard timeout still emits `onLog` (`outcome: "error"`) before rethrowing.
 */
export async function evaluateReviewPrescreenWithGate(input: {
  client: JevClient;
  state: ReviewPrescreenState;
  config?: Partial<ReviewPrescreenConfig>;
  onLog?: ReviewPrescreenLogFn;
}): Promise<ReviewPrescreenDecision> {
  const allPaths = input.state.diff_paths ?? [];
  const outcome = await runReviewPrescreenGate({
    client: input.client,
    state: input.state,
    config: input.config,
  });
  try {
    const decision = applyReviewPrescreen(outcome, allPaths);
    input.onLog?.(logEntryFrom(input.state, decision));
    return decision;
  } catch (error) {
    if (error instanceof ReviewPrescreenTimeoutError) {
      input.onLog?.(logHardTimeout(input.state, error.message));
    }
    throw error;
  }
}

export { ReviewPrescreenTimeoutError };
