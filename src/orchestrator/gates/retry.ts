/**
 * Retry workflow gate (ENG-34).
 * Re-runs the stage with accumulated Flue context (ENG-36) — not an empty session.
 * Default maxAttempts = 3; surfaces attempt + lastError for later UI.
 */

import {
  FLUE_IMPLEMENT_BINDING_STAGE,
  type FlueSessionBindingStore,
} from "../../adapters/flue/session-binding.js";
import { appendReviewFeedback } from "../../adapters/flue/review-feedback.js";
import { requireFlueDurableConversationId } from "./approval.js";
import type { WorkflowGateStore } from "./store.js";
import {
  DEFAULT_RETRY_MAX_ATTEMPTS,
  RetryConfigSchema,
  type RetryConfig,
  type RetryGateResult,
} from "./types.js";

export interface EvaluateRetryInput {
  taskId: string;
  gateId: string;
  stage?: string;
  lastError: string;
  config?: RetryConfig;
  store: WorkflowGateStore;
  sessionBinding: FlueSessionBindingStore;
  now?: () => Date;
}

/**
 * Record a stage failure and decide retry vs exhaust.
 * On retry: append error into implement binding feedback so next Flue dispatch
 * carries accumulated context (same durableConversationId).
 */
export function evaluateRetry(input: EvaluateRetryInput): RetryGateResult {
  const config = RetryConfigSchema.parse(input.config ?? {});
  const maxAttempts = config.maxAttempts ?? DEFAULT_RETRY_MAX_ATTEMPTS;
  const now = input.now ?? (() => new Date());
  const updatedAt = now().toISOString();
  const stage = input.stage ?? FLUE_IMPLEMENT_BINDING_STAGE;
  const lastError = input.lastError.trim() || "unknown_error";

  const prior = input.store.getRetry(input.taskId, input.gateId);
  const nextAttempt = (prior?.attempt ?? 0) + 1;

  input.store.putRetry({
    taskId: input.taskId,
    gateId: input.gateId,
    stage,
    attempt: nextAttempt,
    maxAttempts,
    lastError,
    updatedAt,
  });

  if (nextAttempt > maxAttempts) {
    return {
      kind: "retry",
      outcome: "exhausted",
      taskId: input.taskId,
      gateId: input.gateId,
      attempt: nextAttempt,
      maxAttempts,
      lastError,
      action: "escalate",
    };
  }

  const durableConversationId = requireFlueDurableConversationId(
    input.sessionBinding,
    input.taskId,
  );

  appendReviewFeedback(input.sessionBinding, input.taskId, {
    source: "review",
    summary: `Retry attempt ${nextAttempt}/${maxAttempts}: ${lastError}`,
    mustFix: [lastError],
    verdict: "retry",
    at: updatedAt,
  });

  return {
    kind: "retry",
    outcome: "retry",
    taskId: input.taskId,
    gateId: input.gateId,
    attempt: nextAttempt,
    maxAttempts,
    lastError,
    durableConversationId,
  };
}
