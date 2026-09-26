/**
 * Review gate before the BullMQ ready stage (SPEC §3, §9).
 *
 * kit-harness `checkCompletion` is not on main, so this is the local rules
 * engine plus an optional soft Jev advisor. A hard miss never consults Jev.
 * Missing tests, CI, or the evidence object fails closed.
 *
 * Paths (see docs/review-gate.md):
 * - pass → ready
 * - retry → rework (implementation, carrying review_notes)
 * - fail → replan (planner)
 */
import { UnrecoverableError } from "bullmq";

export const DEFAULT_REVIEW_GATE_ATTEMPTS = 3;

/** Minimum advisor confidence before a soft Jev choice replaces a rules pass. */
export const ADVISOR_CONFIDENCE_MIN = 0.8;

export type CiStatus = "success" | "failure" | "pending" | "missing";

export type ReviewGateVerdict = "pass" | "fail" | "retry";

export type ReviewGatePath = "ready" | "rework" | "replan";

export type ReviewGateEngine = "rules" | "jev";

export interface ReviewGateEvidence {
  tests_green?: boolean;
  ci_status?: CiStatus;
  open_blockers?: string[];
  review_notes?: string;
  attempt?: number;
  max_attempts?: number;
}

export interface AdvisorResult {
  choice?: string;
  confidence?: number;
  reason?: string;
}

/**
 * Soft Jev completion advisor. Same call shape as kit-harness `DecisionAdvisor`
 * for `kind: "completion"`, so a sidecar can be injected without changing the gate.
 */
export interface CompletionAdvisor {
  advise(input: { kind: "completion"; payload: ReviewGateEvidence }): Promise<AdvisorResult | null>;
}

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
  advisor?: CompletionAdvisor | null;
}

interface AttemptBudget {
  attempt: number;
  max: number;
  exhausted: boolean;
}

function budget(evidence: ReviewGateEvidence): AttemptBudget {
  const max =
    evidence.max_attempts && evidence.max_attempts > 0
      ? evidence.max_attempts
      : DEFAULT_REVIEW_GATE_ATTEMPTS;
  const attempt = evidence.attempt && evidence.attempt > 0 ? evidence.attempt : 1;
  return { attempt, max, exhausted: attempt >= max };
}

function decided(
  evidence: ReviewGateEvidence,
  verdict: ReviewGateVerdict,
  reason: string,
  hard: boolean,
  engine: ReviewGateEngine = "rules",
): ReviewGateDecision {
  const { attempt, max } = budget(evidence);
  const path: ReviewGatePath =
    verdict === "pass" ? "ready" : verdict === "retry" ? "rework" : "replan";
  const decision: ReviewGateDecision = {
    verdict,
    path,
    reason,
    hard,
    engine,
    attempt,
    max_attempts: max,
  };
  const notes = evidence.review_notes?.trim();
  if (notes) decision.review_notes = notes;
  return decision;
}

function blockingReason(evidence: ReviewGateEvidence): string | null {
  const blockers = (evidence.open_blockers ?? []).map((item) => item.trim()).filter(Boolean);
  if (blockers.length > 0) return "open_blockers";
  if (evidence.tests_green !== true) {
    return evidence.tests_green === false ? "tests_failed" : "evidence_incomplete";
  }
  if (evidence.ci_status === "success") return null;
  if (evidence.ci_status === "pending") return "ci_pending";
  if (evidence.ci_status === "failure" || evidence.ci_status === "missing") return "ci_failed";
  return "evidence_incomplete";
}

async function consultAdvisor(
  advisor: CompletionAdvisor | null | undefined,
  evidence: ReviewGateEvidence,
): Promise<AdvisorResult | null> {
  if (!advisor) return null;
  try {
    return await advisor.advise({ kind: "completion", payload: evidence });
  } catch {
    return null;
  }
}

function confidentChoice(result: AdvisorResult | null): ReviewGateVerdict | null {
  if (!result?.choice) return null;
  if ((result.confidence ?? 0) < ADVISOR_CONFIDENCE_MIN) return null;
  if (result.choice === "pass" || result.choice === "fail" || result.choice === "retry") {
    return result.choice;
  }
  return null;
}

export async function evaluateReviewGate(
  evidence: ReviewGateEvidence | null | undefined,
  advisor?: CompletionAdvisor | null,
): Promise<ReviewGateDecision> {
  const source = evidence ?? {};
  const reason = blockingReason(source);
  if (reason) {
    if (reason === "open_blockers") return decided(source, "fail", reason, true);
    const { exhausted } = budget(source);
    return decided(source, exhausted ? "fail" : "retry", reason, exhausted);
  }

  const advice = confidentChoice(await consultAdvisor(advisor, source));
  if (advice === "fail" || advice === "retry") {
    return decided(source, advice, "advisor", false, "jev");
  }
  return decided(source, "pass", "checks_passed", false);
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
