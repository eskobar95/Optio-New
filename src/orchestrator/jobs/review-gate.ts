/**
 * Review gate before the BullMQ ready stage (SPEC §3, §9).
 *
 * Completion is `checkCompletion` from kit-harness. This module only maps that
 * verdict onto the pipeline path and carries `review_notes`.
 *
 * Omitted `ci_status` is sent as `missing`, so a run cannot reach ready without
 * an explicit CI success. Jev is consulted inside the harness, and only after
 * the deterministic checks pass.
 *
 * Paths (see docs/review-gate.md):
 * - pass → ready
 * - retry → rework (implementation, carrying review_notes)
 * - fail → replan (planner)
 */
import { UnrecoverableError } from "bullmq";
import { checkCompletion } from "../../kit-harness/completion-check.js";
import type {
  CompletionEvidence,
  DecisionAdvisor,
  DecisionEngine,
} from "../../kit-harness/types.js";

export const DEFAULT_REVIEW_GATE_ATTEMPTS = 3;

export type ReviewGateEvidence = CompletionEvidence & {
  review_notes?: string;
};

export type ReviewGateVerdict = "pass" | "fail" | "retry";

export type ReviewGatePath = "ready" | "rework" | "replan";

export type ReviewGateEngine = DecisionEngine;

export interface ReviewGateDecision {
  verdict: ReviewGateVerdict;
  path: ReviewGatePath;
  reason: string;
  hard: boolean;
  engine: ReviewGateEngine;
  attempt: number;
  max_attempts: number;
  review_notes?: string;
}

/** Loaded by the ready-stage worker. Absent binding leaves the skeleton graph unchanged. */
export interface ReviewGateBinding {
  loadEvidence(identity: {
    taskId: string;
    sessionId: string;
  }): Promise<ReviewGateEvidence | null | undefined>;
  advisor?: DecisionAdvisor | null;
}

function budget(evidence: ReviewGateEvidence): { attempt: number; max: number } {
  const max =
    evidence.max_attempts && evidence.max_attempts > 0
      ? evidence.max_attempts
      : DEFAULT_REVIEW_GATE_ATTEMPTS;
  const attempt = evidence.attempt && evidence.attempt > 0 ? evidence.attempt : 1;
  return { attempt, max };
}

/** Harness treats a missing CI field as success once tests are green. Ready does not. */
function toCompletionEvidence(evidence: ReviewGateEvidence): CompletionEvidence {
  return {
    tests_green: evidence.tests_green,
    typecheck_green: evidence.typecheck_green,
    lint_green: evidence.lint_green,
    diff_present: evidence.diff_present,
    open_blockers: evidence.open_blockers,
    attempt: evidence.attempt,
    max_attempts: evidence.max_attempts,
    ci_status: evidence.ci_status ?? "missing",
  };
}

function pathFor(verdict: ReviewGateVerdict): ReviewGatePath {
  if (verdict === "pass") return "ready";
  if (verdict === "retry") return "rework";
  return "replan";
}

export async function evaluateReviewGate(
  evidence: ReviewGateEvidence | null | undefined,
  advisor?: DecisionAdvisor | null,
): Promise<ReviewGateDecision> {
  const source = evidence ?? {};
  const completion = await checkCompletion(toCompletionEvidence(source), advisor);
  const { attempt, max } = budget(source);
  const decision: ReviewGateDecision = {
    verdict: completion.verdict,
    path: pathFor(completion.verdict),
    reason: completion.reason,
    hard: completion.hard,
    engine: completion.engine,
    attempt,
    max_attempts: max,
  };
  const notes = source.review_notes?.trim();
  if (notes) decision.review_notes = notes;
  return decision;
}

/** Ready must not run. BullMQ treats this as unrecoverable so the job is not retried in place. */
export class ReviewGateClosedError extends UnrecoverableError {
  readonly decision: ReviewGateDecision;

  constructor(decision: ReviewGateDecision) {
    super(`review gate closed: ${decision.path} (${decision.reason})`);
    this.name = "ReviewGateClosedError";
    this.decision = decision;
  }
}
