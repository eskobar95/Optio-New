/**
 * Completion check. Failed evidence never becomes pass via the advisor.
 * The advisor is consulted only after deterministic checks already pass.
 */
import { confidentChoice, consultAdvisor } from "./advisor.js";
import type { CompletionDecision, CompletionEvidence, DecisionAdvisor } from "./types.js";

const DEFAULT_MAX_ATTEMPTS = 3;

function attempts(evidence: CompletionEvidence): {
  attempt: number;
  max: number;
  exhausted: boolean;
} {
  const max =
    evidence.max_attempts && evidence.max_attempts > 0
      ? evidence.max_attempts
      : DEFAULT_MAX_ATTEMPTS;
  const attempt = evidence.attempt && evidence.attempt > 0 ? evidence.attempt : 1;
  return { attempt, max, exhausted: attempt >= max };
}

function ruled(
  verdict: CompletionDecision["verdict"],
  reason: string,
  hard: boolean,
  engine: "rules" | "jev" = "rules",
): CompletionDecision {
  return { verdict, reason, hard, engine };
}

function blockingReason(evidence: CompletionEvidence): string | null {
  const blockers = (evidence.open_blockers ?? []).map((item) => item.trim()).filter(Boolean);
  if (blockers.length > 0) return "open_blockers";
  if (evidence.tests_green !== true) {
    return evidence.tests_green === false ? "tests_failed" : "evidence_incomplete";
  }
  if (evidence.typecheck_green === false) return "typecheck_failed";
  if (evidence.lint_green === false) return "lint_failed";
  if (evidence.diff_present === false) return "no_diff";
  if (evidence.ci_status === "failure" || evidence.ci_status === "missing") return "ci_failed";
  if (evidence.ci_status === "pending") return "ci_pending";
  return null;
}

export async function checkCompletion(
  evidence: CompletionEvidence,
  advisor?: DecisionAdvisor | null,
): Promise<CompletionDecision> {
  const reason = blockingReason(evidence);
  if (reason) {
    if (reason === "open_blockers") return ruled("fail", reason, true);
    const { exhausted } = attempts(evidence);
    return ruled(exhausted ? "fail" : "retry", reason, exhausted);
  }

  const advice = confidentChoice(await consultAdvisor(advisor, "completion", evidence), [
    "pass",
    "fail",
    "retry",
  ]);
  if (advice === "fail" || advice === "retry") return ruled(advice, "advisor", false, "jev");
  return ruled("pass", "checks_passed", false);
}
