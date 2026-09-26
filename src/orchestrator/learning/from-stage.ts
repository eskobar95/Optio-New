/**
 * Map review-gate and implementation failures onto learning observations.
 */
import { redactExcerpt, type LearningObservationInput } from "./observation.js";

export function observationFromReviewGate(input: {
  taskId: string;
  sessionId: string;
  reason: string;
  attempt?: number;
  reviewNotes?: string;
  field?: string;
  skillIds?: readonly string[];
  specialistIds?: readonly string[];
  workflowId?: string;
}): LearningObservationInput {
  return {
    workflowId: input.workflowId,
    stepId: "review",
    skillIds: input.skillIds ? [...input.skillIds] : undefined,
    specialistIds: input.specialistIds ? [...input.specialistIds] : undefined,
    errorClass: input.reason,
    field: input.field,
    taskId: input.taskId,
    sessionId: input.sessionId,
    excerpt: redactExcerpt(input.reviewNotes ?? input.reason),
    source: "review_gate",
    attempt: input.attempt,
  };
}

export function observationFromHandlerFailure(input: {
  taskId: string;
  sessionId: string;
  stage: "implement" | "review";
  step: string;
  error: unknown;
  field?: string;
  skillIds?: readonly string[];
  specialistIds?: readonly string[];
  workflowId?: string;
}): LearningObservationInput {
  const message = input.error instanceof Error ? input.error.message : "handler failed";
  return {
    workflowId: input.workflowId,
    stepId: input.stage,
    skillIds: input.skillIds ? [...input.skillIds] : undefined,
    specialistIds: input.specialistIds ? [...input.specialistIds] : undefined,
    errorClass: "handler_failed",
    field: input.field,
    taskId: input.taskId,
    sessionId: input.sessionId,
    excerpt: redactExcerpt(`${input.step}: ${message}`),
    source: input.stage === "implement" ? "implementation" : "review",
    attempt: 1,
  };
}
