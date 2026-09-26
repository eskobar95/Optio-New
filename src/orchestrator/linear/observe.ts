/**
 * Webhook-side gate. A human move into Review, Merge, or Done is reverted.
 * This path does not open, undraft, or merge a pull request.
 * Phase 1 still comments `queued` and enqueues before this runs.
 */
import { applyWorkflowEffects, type WorkflowPorts } from "./apply.js";
import { updateLinearIssueStateId } from "./status.js";
import { consumeAgentStatusWrite, decideObservedMove } from "./workflow.js";

export async function enforceObservedLinearStatus(input: {
  issueId: string;
  toStatus: string;
  fromStateId?: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  nowMs?: number;
}): Promise<void> {
  const actor = consumeAgentStatusWrite(input.issueId, input.toStatus, input.nowMs ?? Date.now())
    ? "agent"
    : "human";
  const decision = decideObservedMove({
    toStatus: input.toStatus,
    actor,
    fromStateId: input.fromStateId,
  });
  if (decision.effects.length === 0) return;
  const unused = async (): Promise<void> => {
    throw new Error("Linear webhook does not change the GitHub pull request");
  };
  const ports: WorkflowPorts = {
    openDraft: unused,
    markReady: unused,
    merge: unused,
    setStatus: unused,
    comment: async () => undefined,
    escalationStatus: async () => {
      throw new Error("Linear webhook does not escalate");
    },
    revert: async (stateId) => {
      await updateLinearIssueStateId({
        apiKey: input.apiKey,
        issueId: input.issueId,
        stateId,
        fetchImpl: input.fetchImpl,
      });
    },
  };
  await applyWorkflowEffects(decision, ports);
}
