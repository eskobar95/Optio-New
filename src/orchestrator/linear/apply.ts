/**
 * Runs a workflow decision against injected GitHub and Linear ports.
 * A denied decision with no effects changes nothing.
 */
import { LINEAR_STATUS } from "./workflow.js";
import { LinearStatusMissingError } from "./status.js";
import type { WorkflowDecision } from "./workflow.js";

export interface WorkflowPorts {
  openDraft(): Promise<void>;
  markReady(): Promise<void>;
  merge(): Promise<void>;
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
    else if (effect.kind === "github.merge") await ports.merge();
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
  await ports.comment(comment);
}
