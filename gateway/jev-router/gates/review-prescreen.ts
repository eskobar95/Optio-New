/**
 * Gate #4 — review pre-screen before Hannes (ENG-25).
 * Soft gate: timeout / low confidence → passthrough (fail-open) when configured.
 */

import type { JevClient, JevClientResult } from "../jev-client.js";
import { filterToRegistry } from "./skill-pick.js";
import {
  ReviewPrescreenAnswerSchema,
  ReviewPrescreenConfigSchema,
  ReviewPrescreenStateSchema,
  type ReviewPrescreenAnswer,
  type ReviewPrescreenConfig,
  type ReviewPrescreenLabel,
  type ReviewPrescreenState,
} from "./types.js";

export const REVIEW_PRESCREEN_QUESTION = {
  type: "choice",
  instructions:
    "Review pre-screen. Score the diff before the human/review agent (Hannes). Forward the full set when the change is reviewable; filter to the risky/relevant paths when most of the diff is noise (Hannes will be told to review only those paths); escalate when a human must triage first (orchestrator moves to Needs Human — do not leave Review waiting silently).",
  criteria: {
    forward: "Full diff should go to the review agent as-is.",
    filter:
      "Only a subset of diff_paths needs review. Return those exact paths in filtered_paths (must be members of state.diff_paths).",
    needs_human:
      "Do not auto-dispatch the review agent. Escalate to Needs Human with a visible [escalate] signal.",
  },
} as const;

export type ReviewPrescreenPassthroughReason =
  | "timeout"
  | "http"
  | "network"
  | "invalid_url"
  | "invalid_body"
  | "low_confidence"
  | "undecided"
  | "filtered_empty";

export type ReviewPrescreenOutcome =
  | {
      kind: "decided";
      label: Exclude<ReviewPrescreenLabel, "needs_human">;
      confidence: number;
      filteredPaths?: string[];
      notes?: string;
    }
  | {
      kind: "escalate";
      label: "needs_human";
      confidence: number;
      notes?: string;
    }
  | {
      kind: "passthrough";
      reason: ReviewPrescreenPassthroughReason;
      confidence?: number;
      status?: number;
      message?: string;
      notes?: string;
    }
  | {
      /** Hard fail when `passthroughOnTimeout` is false. */
      kind: "error";
      reason: "timeout";
      message?: string;
    };

export class ReviewPrescreenTimeoutError extends Error {
  readonly error_class = "review_prescreen_timeout";

  constructor(message = "Jev review pre-screen gate timed out") {
    super(message);
    this.name = "ReviewPrescreenTimeoutError";
  }
}

function parseAnswer(payload: unknown): ReviewPrescreenAnswer | null {
  if (!payload || typeof payload !== "object") return null;
  const answers = (payload as { answers?: unknown }).answers;
  if (!answers || typeof answers !== "object") return null;
  const raw = (answers as { review_prescreen?: unknown }).review_prescreen;
  const parsed = ReviewPrescreenAnswerSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function outcomeFromClientError(
  result: Extract<JevClientResult, { ok: false }>,
): Extract<ReviewPrescreenOutcome, { kind: "passthrough" }> {
  return {
    kind: "passthrough",
    reason: result.reason,
    ...(result.status !== undefined ? { status: result.status } : {}),
    ...(result.message !== undefined ? { message: result.message } : {}),
  };
}

/**
 * Run gate #4 via shared jevClient.
 * Soft: transport errors / low confidence / undecided → passthrough (forward all).
 * Timeout → passthrough when `passthroughOnTimeout` (default), else `kind: "error"`.
 */
export async function runReviewPrescreenGate(input: {
  client: JevClient;
  state: ReviewPrescreenState;
  config?: Partial<ReviewPrescreenConfig>;
}): Promise<ReviewPrescreenOutcome> {
  const state = ReviewPrescreenStateSchema.parse(input.state);
  const config = ReviewPrescreenConfigSchema.parse(input.config ?? {});

  const result = await input.client.postSystemOne({
    state,
    questions: { review_prescreen: REVIEW_PRESCREEN_QUESTION },
    timeoutMs: config.timeoutMs,
  });

  if (!result.ok) {
    if (result.reason === "timeout" && !config.passthroughOnTimeout) {
      return {
        kind: "error",
        reason: "timeout",
        message: result.message ?? "Jev review pre-screen gate timed out",
      };
    }
    return outcomeFromClientError(result);
  }

  const answer = parseAnswer(result.payload);
  if (!answer) {
    return { kind: "passthrough", reason: "undecided" };
  }

  if (answer.confidence < config.minConfidence) {
    return {
      kind: "passthrough",
      reason: "low_confidence",
      confidence: answer.confidence,
      ...(answer.notes !== undefined ? { notes: answer.notes } : {}),
    };
  }

  if (answer.choice === "needs_human") {
    return {
      kind: "escalate",
      label: "needs_human",
      confidence: answer.confidence,
      ...(answer.notes !== undefined ? { notes: answer.notes } : {}),
    };
  }

  if (answer.choice === "filter") {
    const filteredPaths = filterToRegistry(answer.filtered_paths ?? [], state.diff_paths ?? []);
    if (filteredPaths.length === 0) {
      return {
        kind: "passthrough",
        reason: "filtered_empty",
        confidence: answer.confidence,
        notes: answer.notes ?? "filtered_empty",
      };
    }
    return {
      kind: "decided",
      label: "filter",
      confidence: answer.confidence,
      filteredPaths,
      ...(answer.notes !== undefined ? { notes: answer.notes } : {}),
    };
  }

  return {
    kind: "decided",
    label: "forward",
    confidence: answer.confidence,
    ...(answer.notes !== undefined ? { notes: answer.notes } : {}),
  };
}
