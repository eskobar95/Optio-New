/**
 * Mid-run soft evaluate/decide via shared createJevClient (ENG-27).
 * Soft: transport errors / low confidence / undecided → passthrough.
 */

import type { JevClient, JevClientErrorReason, JevClientResult } from "../jev-client.js";
import {
  DEFAULT_MIDRUN_MIN_CONFIDENCE,
  DEFAULT_MIDRUN_TIMEOUT_MS,
  JevDecideAnswerSchema,
  JevEvaluateAnswerSchema,
  JevMidrunInputSchema,
  type JevDecideAnswer,
  type JevDecideOutcome,
  type JevEvaluateAnswer,
  type JevEvaluateOutcome,
  type JevMidrunInput,
  type JevMidrunKind,
  type JevMidrunPassthroughReason,
  type JevMidrunState,
} from "./schemas.js";
import type { JevMcpTelemetry } from "./telemetry.js";
import { noopJevMcpTelemetry } from "./telemetry.js";

export const MIDRUN_EVALUATE_QUESTION = {
  type: "choice",
  instructions:
    "Soft mid-run evaluate. Pick one recommendation for the Cursor CLI turn. Prefer continue when safe; escalate when ambiguous or high-risk.",
  criteria: {
    continue: "Proceed with the current plan.",
    escalate: "Pause and ask a human.",
    pick_file: "Open or edit a different file next.",
    run_tests: "Run or re-check tests before continuing.",
    defer: "Skip this soft gate; agent chooses unaided.",
  },
} as const;

export const MIDRUN_DECIDE_QUESTION = {
  type: "choice",
  instructions:
    "Soft mid-run decide. Pick one action for the Cursor CLI turn. Soft only — agent may ignore.",
  criteria: {
    continue: "Keep going on the current path.",
    escalate: "Escalate to a human before more edits.",
    pick_file: "Switch to file_path in the answer.",
    run_tests: "Verify tests are green enough.",
    defer: "No strong signal; passthrough-equivalent.",
  },
} as const;

function questionForKind(kind: JevMidrunKind, tool: "evaluate" | "decide") {
  const base = tool === "evaluate" ? MIDRUN_EVALUATE_QUESTION : MIDRUN_DECIDE_QUESTION;
  return {
    ...base,
    kind,
  };
}

function parseEvaluateAnswer(payload: unknown): JevEvaluateAnswer | null {
  if (!payload || typeof payload !== "object") return null;
  const answers = (payload as { answers?: unknown }).answers;
  if (!answers || typeof answers !== "object") return null;
  const raw = (answers as { midrun_evaluate?: unknown }).midrun_evaluate;
  const parsed = JevEvaluateAnswerSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function parseDecideAnswer(payload: unknown): JevDecideAnswer | null {
  if (!payload || typeof payload !== "object") return null;
  const answers = (payload as { answers?: unknown }).answers;
  if (!answers || typeof answers !== "object") return null;
  const raw = (answers as { midrun_decide?: unknown }).midrun_decide;
  const parsed = JevDecideAnswerSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function passthroughFromClientError(result: Extract<JevClientResult, { ok: false }>): {
  kind: "passthrough";
  reason: JevMidrunPassthroughReason;
  status?: number;
  message?: string;
} {
  return {
    kind: "passthrough",
    reason: result.reason as JevClientErrorReason,
    ...(result.status !== undefined ? { status: result.status } : {}),
    ...(result.message !== undefined ? { message: result.message } : {}),
  };
}

function resolveTimeoutMs(input: JevMidrunInput, client: JevClient): number {
  return input.timeoutMs ?? client.timeoutMs ?? DEFAULT_MIDRUN_TIMEOUT_MS;
}

function resolveMinConfidence(input: JevMidrunInput): number {
  return input.minConfidence ?? DEFAULT_MIDRUN_MIN_CONFIDENCE;
}

function taskIdOf(state: JevMidrunState): string {
  return typeof state.task_id === "string" ? state.task_id : "";
}

export async function runJevEvaluate(input: {
  client: JevClient;
  input: unknown;
  telemetry?: JevMcpTelemetry;
}): Promise<JevEvaluateOutcome> {
  const parsed = JevMidrunInputSchema.parse(input.input);
  const telemetry = input.telemetry ?? noopJevMcpTelemetry;
  const timeoutMs = resolveTimeoutMs(parsed, input.client);
  const minConfidence = resolveMinConfidence(parsed);

  const result = await input.client.postSystemOne({
    state: parsed.state,
    questions: {
      midrun_evaluate: questionForKind(parsed.kind, "evaluate"),
    },
    timeoutMs,
  });

  let outcome: JevEvaluateOutcome;
  if (!result.ok) {
    outcome = passthroughFromClientError(result);
  } else {
    const answer = parseEvaluateAnswer(result.payload);
    if (!answer) {
      outcome = { kind: "passthrough", reason: "undecided" };
    } else if (answer.confidence < minConfidence) {
      outcome = {
        kind: "passthrough",
        reason: "low_confidence",
        confidence: answer.confidence,
      };
    } else {
      outcome = {
        kind: "evaluated",
        recommendation: answer.recommendation,
        confidence: answer.confidence,
        ...(answer.note !== undefined ? { note: answer.note } : {}),
      };
    }
  }

  await telemetry.record({
    tool: "jev_evaluate",
    taskId: taskIdOf(parsed.state),
    outcome: outcome.kind,
    reason: outcome.kind === "passthrough" ? outcome.reason : outcome.kind,
    midrunKind: parsed.kind,
  });

  return outcome;
}

export async function runJevDecide(input: {
  client: JevClient;
  input: unknown;
  telemetry?: JevMcpTelemetry;
}): Promise<JevDecideOutcome> {
  const parsed = JevMidrunInputSchema.parse(input.input);
  const telemetry = input.telemetry ?? noopJevMcpTelemetry;
  const timeoutMs = resolveTimeoutMs(parsed, input.client);
  const minConfidence = resolveMinConfidence(parsed);

  const result = await input.client.postSystemOne({
    state: parsed.state,
    questions: {
      midrun_decide: questionForKind(parsed.kind, "decide"),
    },
    timeoutMs,
  });

  let outcome: JevDecideOutcome;
  if (!result.ok) {
    outcome = passthroughFromClientError(result);
  } else {
    const answer = parseDecideAnswer(result.payload);
    if (!answer) {
      outcome = { kind: "passthrough", reason: "undecided" };
    } else if (answer.confidence < minConfidence) {
      outcome = {
        kind: "passthrough",
        reason: "low_confidence",
        confidence: answer.confidence,
      };
    } else if (answer.action === "escalate") {
      outcome = {
        kind: "escalate",
        action: "escalate",
        confidence: answer.confidence,
        ...(answer.note !== undefined ? { note: answer.note } : {}),
      };
    } else if (answer.action === "defer") {
      outcome = {
        kind: "passthrough",
        reason: "undecided",
        confidence: answer.confidence,
        message: answer.note,
      };
    } else {
      outcome = {
        kind: "decided",
        action: answer.action,
        confidence: answer.confidence,
        ...(answer.file_path !== undefined ? { file_path: answer.file_path } : {}),
        ...(answer.note !== undefined ? { note: answer.note } : {}),
      };
    }
  }

  await telemetry.record({
    tool: "jev_decide",
    taskId: taskIdOf(parsed.state),
    outcome: outcome.kind,
    reason: outcome.kind === "passthrough" ? outcome.reason : outcome.kind,
    midrunKind: parsed.kind,
  });

  return outcome;
}
