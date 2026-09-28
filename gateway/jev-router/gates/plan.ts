/**
 * Gate #2 — plan / spec quality (ENG-25).
 * Soft gate: timeout / low confidence → passthrough (fail-open) when configured.
 */

import type { JevClient, JevClientResult } from "../jev-client.js";
import {
  PlanGateAnswerSchema,
  PlanGateConfigSchema,
  PlanGateStateSchema,
  type PlanGateAnswer,
  type PlanGateConfig,
  type PlanGateLabel,
  type PlanGateState,
} from "./types.js";

export const PLAN_GATE_QUESTION = {
  type: "choice",
  instructions:
    "Plan / spec quality gate. Score the plan. Auto-clear only when the plan is high-confidence and safe to implement. Escalate ambiguous or high-risk plans.",
  criteria: {
    auto_clear: "Plan is clear, scoped, and safe. Proceed to implement without revision.",
    needs_revision:
      "Plan has gaps, ambiguity, or missing acceptance criteria. Send back for revision.",
    needs_human: "Policy risk, insufficient signal, or judgment call. Escalate to a human.",
  },
} as const;

export type PlanGatePassthroughReason =
  "timeout" | "http" | "network" | "invalid_url" | "invalid_body" | "low_confidence" | "undecided";

export type PlanGateOutcome =
  | {
      kind: "decided";
      label: Exclude<PlanGateLabel, "needs_human">;
      confidence: number;
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
      reason: PlanGatePassthroughReason;
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

export class PlanGateTimeoutError extends Error {
  readonly error_class = "plan_gate_timeout";

  constructor(message = "Jev plan gate timed out") {
    super(message);
    this.name = "PlanGateTimeoutError";
  }
}

function parseAnswer(payload: unknown): PlanGateAnswer | null {
  if (!payload || typeof payload !== "object") return null;
  const answers = (payload as { answers?: unknown }).answers;
  if (!answers || typeof answers !== "object") return null;
  const raw = (answers as { plan?: unknown }).plan;
  const parsed = PlanGateAnswerSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function outcomeFromClientError(
  result: Extract<JevClientResult, { ok: false }>,
): Extract<PlanGateOutcome, { kind: "passthrough" }> {
  return {
    kind: "passthrough",
    reason: result.reason,
    ...(result.status !== undefined ? { status: result.status } : {}),
    ...(result.message !== undefined ? { message: result.message } : {}),
  };
}

/**
 * Run gate #2 via shared jevClient.
 * Soft: transport errors / low confidence / undecided → passthrough.
 * Timeout → passthrough when `passthroughOnTimeout` (default), else `kind: "error"`.
 */
export async function runPlanGate(input: {
  client: JevClient;
  state: PlanGateState;
  config?: Partial<PlanGateConfig>;
}): Promise<PlanGateOutcome> {
  const state = PlanGateStateSchema.parse(input.state);
  const config = PlanGateConfigSchema.parse(input.config ?? {});

  const result = await input.client.postSystemOne({
    state,
    questions: { plan: PLAN_GATE_QUESTION },
    timeoutMs: config.timeoutMs,
  });

  if (!result.ok) {
    if (result.reason === "timeout" && !config.passthroughOnTimeout) {
      return {
        kind: "error",
        reason: "timeout",
        message: result.message ?? "Jev plan gate timed out",
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

  return {
    kind: "decided",
    label: answer.choice,
    confidence: answer.confidence,
    ...(answer.notes !== undefined ? { notes: answer.notes } : {}),
  };
}
