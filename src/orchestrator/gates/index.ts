/**
 * Workflow gates (ENG-34) — approval / conditional / retry / smart_routing.
 * Runtime stubs for Optio orchestrator; UI deferred to ENG-28/31.
 */

export {
  pauseApproval,
  requireFlueDurableConversationId,
  resumeApproval,
  type PauseApprovalInput,
  type ResumeApprovalInput,
} from "./approval.js";
export { evaluateConditional, type EvaluateConditionalInput } from "./conditional.js";
export {
  evaluateWorkflowGate,
  type EvaluateWorkflowGateDeps,
  type EvaluateWorkflowGateRequest,
} from "./evaluate.js";
export { evaluateRetry, type EvaluateRetryInput } from "./retry.js";
export {
  createPassthroughJevSmartRouting,
  evaluateSmartRouting,
  type EvaluateSmartRoutingInput,
  type JevSmartRoutingPort,
} from "./smart-routing.js";
export { InMemoryWorkflowGateStore, workflowGateKey, type WorkflowGateStore } from "./store.js";
export {
  APPROVAL_ACTIONS,
  APPROVAL_STATUSES,
  ApprovalActionSchema,
  ApprovalConfigSchema,
  ApprovalStatusSchema,
  CONDITIONAL_PRESETS,
  ConditionalConfigSchema,
  ConditionalEvidenceSchema,
  ConditionalPresetSchema,
  DEFAULT_RETRY_MAX_ATTEMPTS,
  RetryConfigSchema,
  SMART_ROUTING_PATHS,
  SmartRoutingConfigSchema,
  SmartRoutingInputSchema,
  SmartRoutingPathSchema,
  SmartRoutingResultSchema,
  WORKFLOW_GATE_KINDS,
  WorkflowGateError,
  WorkflowGateErrorCodeSchema,
  WorkflowGateKindSchema,
  type ApprovalAction,
  type ApprovalConfig,
  type ApprovalGateRecord,
  type ApprovalPauseResult,
  type ApprovalResumeResult,
  type ApprovalStatus,
  type ConditionalConfig,
  type ConditionalEvidence,
  type ConditionalGateResult,
  type ConditionalPreset,
  type RetryConfig,
  type RetryGateRecord,
  type RetryGateResult,
  type SmartRoutingConfig,
  type SmartRoutingGateResult,
  type SmartRoutingInput,
  type SmartRoutingPath,
  type SmartRoutingResult,
  type WorkflowGateErrorCode,
  type WorkflowGateKind,
  type WorkflowGateResult,
} from "./types.js";
