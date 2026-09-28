/**
 * Approval workflow gate (ENG-34).
 * Pause/resume must reuse the same Flue durable session (ENG-36) — never cold-start.
 */

import {
  FLUE_IMPLEMENT_BINDING_STAGE,
  type FlueSessionBindingStore,
} from "../../adapters/flue/session-binding.js";
import { appendReviewFeedback } from "../../adapters/flue/review-feedback.js";
import type { WorkflowGateStore } from "./store.js";
import {
  ApprovalActionSchema,
  WorkflowGateError,
  type ApprovalAction,
  type ApprovalPauseResult,
  type ApprovalResumeResult,
} from "./types.js";

export interface PauseApprovalInput {
  taskId: string;
  gateId: string;
  store: WorkflowGateStore;
  sessionBinding: FlueSessionBindingStore;
  now?: () => Date;
}

export interface ResumeApprovalInput {
  taskId: string;
  gateId: string;
  action: ApprovalAction;
  /** Required for send_back. */
  comment?: string;
  store: WorkflowGateStore;
  sessionBinding: FlueSessionBindingStore;
  now?: () => Date;
}

/** Require a non-empty Flue durableConversationId for the implement binding. */
export function requireFlueDurableConversationId(
  sessionBinding: FlueSessionBindingStore,
  taskId: string,
): string {
  const binding = sessionBinding.get(taskId, FLUE_IMPLEMENT_BINDING_STAGE);
  const id = binding?.durableConversationId?.trim() ?? "";
  if (!id) {
    throw new WorkflowGateError(
      "missing_flue_binding",
      `No Flue durableConversationId for task ${taskId} (stage implement); refuse cold-start`,
    );
  }
  return id;
}

/**
 * Open an approval gate — flow pauses until resumeApproval.
 * Requires an existing Flue binding (fail-closed). Idempotent if already pending.
 */
export function pauseApproval(input: PauseApprovalInput): ApprovalPauseResult {
  requireFlueDurableConversationId(input.sessionBinding, input.taskId);

  const existing = input.store.getApproval(input.taskId, input.gateId);
  if (existing) {
    if (existing.status === "pending") {
      return {
        kind: "approval",
        outcome: "paused",
        taskId: input.taskId,
        gateId: input.gateId,
        status: "pending",
      };
    }
    throw new WorkflowGateError(
      "already_decided",
      `Approval gate ${input.gateId} for task ${input.taskId} is already ${existing.status}`,
    );
  }

  const now = input.now ?? (() => new Date());
  const openedAt = now().toISOString();
  input.store.putApproval({
    taskId: input.taskId,
    gateId: input.gateId,
    status: "pending",
    openedAt,
  });
  return {
    kind: "approval",
    outcome: "paused",
    taskId: input.taskId,
    gateId: input.gateId,
    status: "pending",
  };
}

/**
 * Human decision on a pending approval.
 * Always resumes the same Flue durableConversationId — never invents a new one.
 */
export function resumeApproval(input: ResumeApprovalInput): ApprovalResumeResult {
  const action = ApprovalActionSchema.parse(input.action);
  const now = input.now ?? (() => new Date());
  const decidedAt = now().toISOString();

  const pending = input.store.getApproval(input.taskId, input.gateId);
  if (!pending || pending.status !== "pending") {
    throw new WorkflowGateError(
      "not_pending",
      `Approval gate ${input.gateId} for task ${input.taskId} is not pending`,
    );
  }

  const durableConversationId = requireFlueDurableConversationId(
    input.sessionBinding,
    input.taskId,
  );

  if (action === "approve") {
    input.store.putApproval({
      ...pending,
      status: "approved",
      decidedAt,
    });
    return {
      kind: "approval",
      outcome: "approved",
      taskId: input.taskId,
      gateId: input.gateId,
      action: "continue",
      durableConversationId,
    };
  }

  if (action === "reject") {
    input.store.putApproval({
      ...pending,
      status: "rejected",
      decidedAt,
    });
    return {
      kind: "approval",
      outcome: "rejected",
      taskId: input.taskId,
      gateId: input.gateId,
      action: "stop",
      durableConversationId,
    };
  }

  const comment = input.comment?.trim() ?? "";
  if (!comment) {
    throw new WorkflowGateError("invalid_config", "send_back requires a non-empty comment");
  }

  appendReviewFeedback(input.sessionBinding, input.taskId, {
    source: "gate_send_back",
    summary: comment,
    mustFix: [comment],
    verdict: "send_back",
    at: decidedAt,
  });

  input.store.putApproval({
    ...pending,
    status: "send_back",
    comment,
    decidedAt,
  });

  return {
    kind: "approval",
    outcome: "send_back",
    taskId: input.taskId,
    gateId: input.gateId,
    action: "continue",
    durableConversationId,
    comment,
  };
}
