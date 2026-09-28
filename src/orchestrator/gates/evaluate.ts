/**
 * Workflow gate dispatcher (ENG-34).
 * Thin evaluate/resume helpers — no BullMQ wiring in this stub.
 */

import type { FlueSessionBindingStore } from "../../adapters/flue/session-binding.js";
import { pauseApproval, resumeApproval } from "./approval.js";
import { evaluateConditional } from "./conditional.js";
import { evaluateRetry } from "./retry.js";
import { evaluateSmartRouting, type JevSmartRoutingPort } from "./smart-routing.js";
import type { WorkflowGateStore } from "./store.js";
import {
  WorkflowGateError,
  WorkflowGateKindSchema,
  type ApprovalAction,
  type ConditionalConfig,
  type ConditionalEvidence,
  type RetryConfig,
  type SmartRoutingConfig,
  type SmartRoutingInput,
  type WorkflowGateResult,
} from "./types.js";

export interface EvaluateWorkflowGateDeps {
  store: WorkflowGateStore;
  sessionBinding: FlueSessionBindingStore;
  smartRouter?: JevSmartRoutingPort;
  now?: () => Date;
}

export type EvaluateWorkflowGateRequest =
  | {
      kind: "approval";
      taskId: string;
      gateId: string;
      /** Omit to pause; set to resume. */
      action?: ApprovalAction;
      comment?: string;
    }
  | {
      kind: "conditional";
      config: ConditionalConfig;
      evidence: ConditionalEvidence;
    }
  | {
      kind: "retry";
      taskId: string;
      gateId: string;
      stage?: string;
      lastError: string;
      config?: RetryConfig;
    }
  | {
      kind: "smart_routing";
      input: SmartRoutingInput;
      config?: SmartRoutingConfig;
    };

/**
 * Evaluate or resume a workflow gate.
 * Approval without `action` opens a pause; with `action` resumes via Flue binding.
 */
export async function evaluateWorkflowGate(
  request: EvaluateWorkflowGateRequest,
  deps: EvaluateWorkflowGateDeps,
): Promise<WorkflowGateResult> {
  WorkflowGateKindSchema.parse(request.kind);

  switch (request.kind) {
    case "approval": {
      if (!request.action) {
        return pauseApproval({
          taskId: request.taskId,
          gateId: request.gateId,
          store: deps.store,
          sessionBinding: deps.sessionBinding,
          now: deps.now,
        });
      }
      return resumeApproval({
        taskId: request.taskId,
        gateId: request.gateId,
        action: request.action,
        comment: request.comment,
        store: deps.store,
        sessionBinding: deps.sessionBinding,
        now: deps.now,
      });
    }
    case "conditional":
      return evaluateConditional({
        config: request.config,
        evidence: request.evidence,
      });
    case "retry":
      return evaluateRetry({
        taskId: request.taskId,
        gateId: request.gateId,
        stage: request.stage,
        lastError: request.lastError,
        config: request.config,
        store: deps.store,
        sessionBinding: deps.sessionBinding,
        now: deps.now,
      });
    case "smart_routing":
      return evaluateSmartRouting({
        input: request.input,
        config: request.config,
        router: deps.smartRouter,
      });
    default: {
      const _exhaustive: never = request;
      throw new WorkflowGateError(
        "unknown_kind",
        `Unknown workflow gate kind: ${JSON.stringify(_exhaustive)}`,
      );
    }
  }
}
