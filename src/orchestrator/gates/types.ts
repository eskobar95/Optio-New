/**
 * Workflow gate runtime contracts (ENG-34).
 * Orchestrator/runtime stubs for approval / conditional / retry / smart_routing.
 * Distinct from harness security gates (`src/harness/gates`) and Jev soft gates (ENG-25).
 * UI rows belong to ENG-28/31 — not this module.
 */

import { z } from "zod";

export const WORKFLOW_GATE_KINDS = ["approval", "conditional", "retry", "smart_routing"] as const;
export const WorkflowGateKindSchema = z.enum(WORKFLOW_GATE_KINDS);
export type WorkflowGateKind = z.infer<typeof WorkflowGateKindSchema>;

export const DEFAULT_RETRY_MAX_ATTEMPTS = 3;

export const APPROVAL_ACTIONS = ["approve", "reject", "send_back"] as const;
export const ApprovalActionSchema = z.enum(APPROVAL_ACTIONS);
export type ApprovalAction = z.infer<typeof ApprovalActionSchema>;

export const APPROVAL_STATUSES = ["pending", "approved", "rejected", "send_back"] as const;
export const ApprovalStatusSchema = z.enum(APPROVAL_STATUSES);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const ApprovalConfigSchema = z
  .object({
    /** Optional human-facing label for later UI. */
    label: z.string().min(1).optional(),
  })
  .strict()
  .default({});
export type ApprovalConfig = z.infer<typeof ApprovalConfigSchema>;

export const CONDITIONAL_PRESETS = [
  "ci_status",
  "conflict_check",
  "coverage_threshold",
  "custom",
] as const;
export const ConditionalPresetSchema = z.enum(CONDITIONAL_PRESETS);
export type ConditionalPreset = z.infer<typeof ConditionalPresetSchema>;

export const ConditionalConfigSchema = z
  .object({
    preset: ConditionalPresetSchema,
    /** Required when preset is `coverage_threshold` (0–100). */
    coverageMinPercent: z.number().min(0).max(100).optional(),
    /** Required when preset is `custom` — opaque rule id for later evaluators. */
    customRuleId: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.preset === "coverage_threshold" && value.coverageMinPercent === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "coverage_threshold requires coverageMinPercent",
        path: ["coverageMinPercent"],
      });
    }
    if (value.preset === "custom" && !value.customRuleId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "custom preset requires customRuleId",
        path: ["customRuleId"],
      });
    }
  });
export type ConditionalConfig = z.infer<typeof ConditionalConfigSchema>;

export const ConditionalEvidenceSchema = z
  .object({
    ciStatus: z.enum(["success", "failure", "pending", "missing"]).optional(),
    hasConflict: z.boolean().optional(),
    coveragePercent: z.number().min(0).max(100).optional(),
    /** Custom rule evaluation result when preset is `custom`. */
    customPass: z.boolean().optional(),
  })
  .strict();
export type ConditionalEvidence = z.infer<typeof ConditionalEvidenceSchema>;

export const RetryConfigSchema = z
  .object({
    maxAttempts: z.number().int().positive().default(DEFAULT_RETRY_MAX_ATTEMPTS),
  })
  .strict();
export type RetryConfig = z.infer<typeof RetryConfigSchema>;

export const SMART_ROUTING_PATHS = ["human_review", "auto_continue"] as const;
export const SmartRoutingPathSchema = z.enum(SMART_ROUTING_PATHS);
export type SmartRoutingPath = z.infer<typeof SmartRoutingPathSchema>;

export const SmartRoutingConfigSchema = z
  .object({
    /** Soft fail-open: port throw → auto_continue. */
    failOpen: z.boolean().default(true),
  })
  .strict()
  .default({});
export type SmartRoutingConfig = z.infer<typeof SmartRoutingConfigSchema>;

export const SmartRoutingInputSchema = z
  .object({
    taskId: z.string().min(1),
    stage: z.string().min(1),
    priority: z.enum(["urgent", "high", "medium", "low", "none"]).optional(),
    labels: z.array(z.string().min(1)).default([]),
    classification: z.string().min(1).optional(),
  })
  .strict();
export type SmartRoutingInput = z.infer<typeof SmartRoutingInputSchema>;

export const SmartRoutingResultSchema = z
  .object({
    path: SmartRoutingPathSchema,
    reason: z.string().min(1).optional(),
  })
  .strict();
export type SmartRoutingResult = z.infer<typeof SmartRoutingResultSchema>;

export const WorkflowGateErrorCodeSchema = z.enum([
  "missing_flue_binding",
  "not_pending",
  "already_decided",
  "invalid_config",
  "port_failed",
  "unknown_kind",
]);
export type WorkflowGateErrorCode = z.infer<typeof WorkflowGateErrorCodeSchema>;

export class WorkflowGateError extends Error {
  readonly code: WorkflowGateErrorCode;

  constructor(code: WorkflowGateErrorCode, message: string) {
    super(message);
    this.name = "WorkflowGateError";
    this.code = code;
  }
}

/** Persisted approval row in the gate store. */
export interface ApprovalGateRecord {
  taskId: string;
  gateId: string;
  status: ApprovalStatus;
  comment?: string;
  openedAt: string;
  decidedAt?: string;
}

/** Persisted retry counter + last error for later UI. */
export interface RetryGateRecord {
  taskId: string;
  gateId: string;
  stage: string;
  attempt: number;
  maxAttempts: number;
  lastError?: string;
  updatedAt: string;
}

export type ApprovalPauseResult = {
  kind: "approval";
  outcome: "paused";
  taskId: string;
  gateId: string;
  status: "pending";
};

export type ApprovalResumeResult =
  | {
      kind: "approval";
      outcome: "approved";
      taskId: string;
      gateId: string;
      action: "continue";
      durableConversationId: string;
    }
  | {
      kind: "approval";
      outcome: "rejected";
      taskId: string;
      gateId: string;
      action: "stop";
      durableConversationId: string;
    }
  | {
      kind: "approval";
      outcome: "send_back";
      taskId: string;
      gateId: string;
      action: "continue";
      durableConversationId: string;
      comment: string;
    };

export type ConditionalGateResult = {
  kind: "conditional";
  outcome: "pass" | "fail";
  preset: ConditionalPreset;
  reason: string;
};

export type RetryGateResult =
  | {
      kind: "retry";
      outcome: "retry";
      taskId: string;
      gateId: string;
      attempt: number;
      maxAttempts: number;
      lastError: string;
      durableConversationId: string;
    }
  | {
      kind: "retry";
      outcome: "exhausted";
      taskId: string;
      gateId: string;
      attempt: number;
      maxAttempts: number;
      lastError: string;
      action: "escalate";
    };

export type SmartRoutingGateResult = {
  kind: "smart_routing";
  outcome: "route";
  path: SmartRoutingPath;
  reason: string;
};

export type WorkflowGateResult =
  | ApprovalPauseResult
  | ApprovalResumeResult
  | ConditionalGateResult
  | RetryGateResult
  | SmartRoutingGateResult;
