/**
 * Gate #5 — intake triage for Linear / intake issues (ENG-25).
 * Soft gate: timeout / low confidence → passthrough (fail-open) when configured.
 */

import type { JevClient, JevClientResult } from "../jev-client.js";
import {
  IntakeTriageAnswerSchema,
  IntakeTriageConfigSchema,
  IntakeTriageStateSchema,
  type IntakeTriageAnswer,
  type IntakeTriageConfig,
  type IntakeTriageLabel,
  type IntakeTriageState,
} from "./types.js";

export const INTAKE_TRIAGE_QUESTION = {
  type: "choice",
  instructions:
    "Intake triage. Classify the Linear / intake issue before the factory enqueues plan→implement. Enqueue clear, actionable work. Ask for clarify when the brief is incomplete. Reject spam or out-of-scope noise. Escalate policy or judgment calls.",
  criteria: {
    enqueue: "Issue is actionable. Proceed to enqueue the pipeline.",
    clarify: "Missing acceptance criteria or scope. Do not enqueue; ask for clarification.",
    reject: "Not factory work (spam, duplicate noise, wrong project). Do not enqueue.",
    needs_human: "Policy risk or judgment call. Escalate to a human before enqueue.",
  },
} as const;

export type IntakeTriagePassthroughReason =
  "timeout" | "http" | "network" | "invalid_url" | "invalid_body" | "low_confidence" | "undecided";

export type IntakeTriageOutcome =
  | {
      kind: "decided";
      label: Exclude<IntakeTriageLabel, "needs_human">;
      confidence: number;
      labels?: string[];
      notes?: string;
    }
  | {
      kind: "escalate";
      label: "needs_human";
      confidence: number;
      labels?: string[];
      notes?: string;
    }
  | {
      kind: "passthrough";
      reason: IntakeTriagePassthroughReason;
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

export class IntakeTriageTimeoutError extends Error {
  readonly error_class = "intake_triage_timeout";

  constructor(message = "Jev intake triage gate timed out") {
    super(message);
    this.name = "IntakeTriageTimeoutError";
  }
}

function parseAnswer(payload: unknown): IntakeTriageAnswer | null {
  if (!payload || typeof payload !== "object") return null;
  const answers = (payload as { answers?: unknown }).answers;
  if (!answers || typeof answers !== "object") return null;
  const raw = (answers as { intake?: unknown }).intake;
  const parsed = IntakeTriageAnswerSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function outcomeFromClientError(
  result: Extract<JevClientResult, { ok: false }>,
): Extract<IntakeTriageOutcome, { kind: "passthrough" }> {
  return {
    kind: "passthrough",
    reason: result.reason,
    ...(result.status !== undefined ? { status: result.status } : {}),
    ...(result.message !== undefined ? { message: result.message } : {}),
  };
}

/**
 * Run gate #5 via shared jevClient.
 * Soft: transport errors / low confidence / undecided → passthrough (enqueue).
 * Timeout → passthrough when `passthroughOnTimeout` (default), else `kind: "error"`.
 */
export async function runIntakeTriageGate(input: {
  client: JevClient;
  state: IntakeTriageState;
  config?: Partial<IntakeTriageConfig>;
}): Promise<IntakeTriageOutcome> {
  const state = IntakeTriageStateSchema.parse(input.state);
  const config = IntakeTriageConfigSchema.parse(input.config ?? {});

  const result = await input.client.postSystemOne({
    state,
    questions: { intake: INTAKE_TRIAGE_QUESTION },
    timeoutMs: config.timeoutMs,
  });

  if (!result.ok) {
    if (result.reason === "timeout" && !config.passthroughOnTimeout) {
      return {
        kind: "error",
        reason: "timeout",
        message: result.message ?? "Jev intake triage gate timed out",
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
      ...(answer.labels !== undefined ? { labels: answer.labels } : {}),
      ...(answer.notes !== undefined ? { notes: answer.notes } : {}),
    };
  }

  return {
    kind: "decided",
    label: answer.choice,
    confidence: answer.confidence,
    ...(answer.labels !== undefined ? { labels: answer.labels } : {}),
    ...(answer.notes !== undefined ? { notes: answer.notes } : {}),
  };
}
