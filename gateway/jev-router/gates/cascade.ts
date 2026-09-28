/**
 * Gate #1 — backend / model cascade (ENG-25).
 * Soft gate: timeout / low confidence → passthrough (fail-open) when configured.
 */

import type { JevClient, JevClientResult } from "../jev-client.js";
import {
  BackendCascadeAnswerSchema,
  BackendCascadeConfigSchema,
  BackendCascadeStateSchema,
  type BackendCascadeAnswer,
  type BackendCascadeConfig,
  type BackendCascadeLabel,
  type BackendCascadeState,
} from "./types.js";

export const BACKEND_CASCADE_QUESTION = {
  type: "choice",
  instructions:
    "Hop 1 backend/model cascade. Pick one label for issue complexity. Escalate to needs_human when ambiguous or high-risk.",
  criteria: {
    flue_cheap: "Simple, low-risk change. Prefer Flue with a cheap model.",
    cursor_composer: "Medium complexity. Cursor with a composer-tier model.",
    cursor_frontier: "Hard or high-stakes change. Cursor with a frontier model.",
    needs_human: "Ambiguous scope, policy risk, or insufficient signal. Escalate to a human.",
  },
} as const;

export type CascadeModelTier = "composer" | "frontier";

export type CascadeCodingTarget =
  { backend: "flue"; modelTier?: undefined } | { backend: "cursor"; modelTier: CascadeModelTier };

export type BackendCascadePassthroughReason =
  "timeout" | "http" | "network" | "invalid_url" | "invalid_body" | "low_confidence" | "undecided";

export type BackendCascadeOutcome =
  | {
      kind: "decided";
      label: Exclude<BackendCascadeLabel, "needs_human">;
      confidence: number;
      target: CascadeCodingTarget;
    }
  | {
      kind: "escalate";
      label: "needs_human";
      confidence: number;
    }
  | {
      kind: "passthrough";
      reason: BackendCascadePassthroughReason;
      confidence?: number;
      status?: number;
      message?: string;
    }
  | {
      /** Hard fail when `passthroughOnTimeout` is false. */
      kind: "error";
      reason: "timeout";
      message?: string;
    };

export class BackendCascadeTimeoutError extends Error {
  readonly error_class = "backend_cascade_timeout";

  constructor(message = "Jev backend_cascade timed out") {
    super(message);
    this.name = "BackendCascadeTimeoutError";
  }
}

export function mapCascadeLabelToTarget(
  label: Exclude<BackendCascadeLabel, "needs_human">,
): CascadeCodingTarget {
  if (label === "flue_cheap") return { backend: "flue" };
  if (label === "cursor_composer") return { backend: "cursor", modelTier: "composer" };
  return { backend: "cursor", modelTier: "frontier" };
}

function parseAnswer(payload: unknown): BackendCascadeAnswer | null {
  if (!payload || typeof payload !== "object") return null;
  const answers = (payload as { answers?: unknown }).answers;
  if (!answers || typeof answers !== "object") return null;
  const raw = (answers as { backend_cascade?: unknown }).backend_cascade;
  const parsed = BackendCascadeAnswerSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function outcomeFromClientError(
  result: Extract<JevClientResult, { ok: false }>,
): Extract<BackendCascadeOutcome, { kind: "passthrough" }> {
  return {
    kind: "passthrough",
    reason: result.reason,
    ...(result.status !== undefined ? { status: result.status } : {}),
    ...(result.message !== undefined ? { message: result.message } : {}),
  };
}

/**
 * Run gate #1 via shared jevClient.
 * Soft: transport errors / low confidence / undecided → passthrough.
 * Timeout → passthrough when `passthroughOnTimeout` (default), else `kind: "error"`.
 */
export async function runBackendCascadeGate(input: {
  client: JevClient;
  state: BackendCascadeState;
  config?: Partial<BackendCascadeConfig>;
}): Promise<BackendCascadeOutcome> {
  const state = BackendCascadeStateSchema.parse(input.state);
  const config = BackendCascadeConfigSchema.parse(input.config ?? {});

  const result = await input.client.postSystemOne({
    state,
    questions: { backend_cascade: BACKEND_CASCADE_QUESTION },
    timeoutMs: config.timeoutMs,
  });

  if (!result.ok) {
    if (result.reason === "timeout" && !config.passthroughOnTimeout) {
      return {
        kind: "error",
        reason: "timeout",
        message: result.message ?? "Jev backend_cascade timed out",
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
    };
  }

  if (answer.choice === "needs_human") {
    return { kind: "escalate", label: "needs_human", confidence: answer.confidence };
  }

  return {
    kind: "decided",
    label: answer.choice,
    confidence: answer.confidence,
    target: mapCascadeLabelToTarget(answer.choice),
  };
}
