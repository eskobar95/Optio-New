/**
 * Runs a workflow decision against injected GitHub and Linear ports.
 * A denied decision with no effects changes nothing.
 */
import { LINEAR_STATUS, statusLogComment } from "./workflow.js";
import { LinearStatusMissingError } from "./status.js";
import type { WorkflowDecision } from "./workflow.js";

export interface WorkflowPorts {
  openDraft(): Promise<void>;
  markReady(): Promise<void>;
  /** Request `OPTIO_REVIEW_GITHUB_LOGINS`. Empty config is a no-op. */
  requestReviewers(): Promise<void>;
  /** Run the review agent and post `[optio-review]` when this head has none yet. */
  dispatchReview(): Promise<void>;
  merge(): Promise<void>;
  /** Re-request review and comment. Must not convert the pull request to a draft. */
  rereview(comment: string): Promise<void>;
  setStatus(status: string): Promise<void>;
  comment(body: string): Promise<void>;
  revert(stateId: string): Promise<void>;
  /** Column check used only by the escalate effect. */
  escalationStatus(): Promise<string>;
}

export async function applyWorkflowEffects(
  decision: WorkflowDecision,
  ports: WorkflowPorts,
): Promise<void> {
  for (const effect of decision.effects) {
    if (effect.kind === "github.draft") await ports.openDraft();
    else if (effect.kind === "github.ready") await ports.markReady();
    else if (effect.kind === "github.request_reviewers") await ports.requestReviewers();
    else if (effect.kind === "github.dispatch_review") await ports.dispatchReview();
    else if (effect.kind === "github.merge") await ports.merge();
    else if (effect.kind === "github.rereview") await ports.rereview(effect.comment);
    else if (effect.kind === "linear.status") await ports.setStatus(effect.status);
    else if (effect.kind === "linear.comment") await ports.comment(effect.body);
    else if (effect.kind === "linear.revert") await ports.revert(effect.stateId);
    else await escalate(effect.comment, ports);
  }
}

async function escalate(comment: string, ports: WorkflowPorts): Promise<void> {
  let status: string = LINEAR_STATUS.needsHuman;
  try {
    status = await ports.escalationStatus();
    await ports.setStatus(status);
  } catch (error) {
    if (!(error instanceof LinearStatusMissingError)) throw error;
    status = LINEAR_STATUS.inProgress;
    await ports.setStatus(status);
  }
  await ports.comment(
    statusLogComment({
      status,
      trigger: "agent",
      rationale: "Autonomous work stopped. A human needs to take the next step.",
    }),
  );
  await ports.comment(comment);
}
