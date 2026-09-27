/**
 * Orchestrator form of `.cursor/skills/land`.
 * `scripts/lib/land-policy.mjs` is not in this repo. The rule is the same:
 * merge only when CI is green and the review approver has passed.
 * The caller writes Done only after `github.merge` succeeds.
 */
import type { CiState } from "./workflow.js";

export function landAtMergeGate(input: {
  ci?: CiState;
  reviewApproved: boolean;
}): { ok: true } | { ok: false; reason: "ci_not_green" | "review_not_approved" } {
  if (input.ci !== "green") return { ok: false, reason: "ci_not_green" };
  if (!input.reviewApproved) return { ok: false, reason: "review_not_approved" };
  return { ok: true };
}
