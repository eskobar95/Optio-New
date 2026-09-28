/**
 * Jev gate sequence contracts (ENG-25).
 * Gates #1–2 implemented; #3–5 are typed stubs only.
 */

import { z } from "zod";

/** Mirrors optio.jev_gate_kind (ENG-24). Ordered rollout: 1→5. */
export const JevGateKindSchema = z.enum([
  "backend_cascade",
  "plan",
  "skill_pick",
  "review_prescreen",
  "intake",
]);
export type JevGateKind = z.infer<typeof JevGateKindSchema>;

/** Ordered gate sequence for docs and callers. */
export const JEV_GATE_SEQUENCE = [
  "backend_cascade",
  "plan",
  "skill_pick",
  "review_prescreen",
  "intake",
] as const satisfies readonly JevGateKind[];

/** Gate #1 cascade labels — complexity → backend/model tier. */
export const BackendCascadeLabelSchema = z.enum([
  "flue_cheap",
  "cursor_composer",
  "cursor_frontier",
  "needs_human",
]);
export type BackendCascadeLabel = z.infer<typeof BackendCascadeLabelSchema>;

export const DEFAULT_CASCADE_MIN_CONFIDENCE = 0.7;
export const DEFAULT_CASCADE_TIMEOUT_MS = 30_000;

export const BackendCascadeConfigSchema = z
  .object({
    minConfidence: z.number().min(0).max(1).default(DEFAULT_CASCADE_MIN_CONFIDENCE),
    timeoutMs: z.number().int().positive().default(DEFAULT_CASCADE_TIMEOUT_MS),
    passthroughOnTimeout: z.boolean().default(true),
  })
  .strict();
export type BackendCascadeConfig = z.infer<typeof BackendCascadeConfigSchema>;

export const BackendCascadeStateSchema = z
  .object({
    task_id: z.string().optional(),
    workflow_id: z.string().optional(),
    step_id: z.string().optional(),
    issue_title: z.string().optional(),
    issue_body: z.string().optional(),
    estimated_complexity: z.enum(["low", "medium", "high", "unknown"]).optional(),
  })
  .passthrough();
export type BackendCascadeState = z.infer<typeof BackendCascadeStateSchema>;

export const BackendCascadeAnswerSchema = z
  .object({
    choice: BackendCascadeLabelSchema,
    confidence: z.number().min(0).max(1),
  })
  .strict();
export type BackendCascadeAnswer = z.infer<typeof BackendCascadeAnswerSchema>;

/** Wire response fragment under answers.backend_cascade. */
export const BackendCascadeSystemOneResponseSchema = z
  .object({
    answers: z
      .object({
        backend_cascade: BackendCascadeAnswerSchema,
      })
      .passthrough(),
  })
  .passthrough();

// --- Gate #2 — plan / spec quality ---

/** Gate #2 plan labels — plan quality → clear / revise / escalate. */
export const PlanGateLabelSchema = z.enum(["auto_clear", "needs_revision", "needs_human"]);
export type PlanGateLabel = z.infer<typeof PlanGateLabelSchema>;

export const DEFAULT_PLAN_MIN_CONFIDENCE = 0.7;
export const DEFAULT_PLAN_TIMEOUT_MS = 30_000;

export const PlanGateConfigSchema = z
  .object({
    minConfidence: z.number().min(0).max(1).default(DEFAULT_PLAN_MIN_CONFIDENCE),
    timeoutMs: z.number().int().positive().default(DEFAULT_PLAN_TIMEOUT_MS),
    passthroughOnTimeout: z.boolean().default(true),
  })
  .strict();
export type PlanGateConfig = z.infer<typeof PlanGateConfigSchema>;

export const PlanGateStateSchema = z
  .object({
    task_id: z.string().optional(),
    workflow_id: z.string().optional(),
    step_id: z.string().optional(),
    plan_text: z.string().optional(),
    task_type: z.string().optional(),
    issue_title: z.string().optional(),
    issue_body: z.string().optional(),
  })
  .passthrough();
export type PlanGateState = z.infer<typeof PlanGateStateSchema>;

export const PlanGateAnswerSchema = z
  .object({
    choice: PlanGateLabelSchema,
    confidence: z.number().min(0).max(1),
    notes: z.string().optional(),
  })
  .strict();
export type PlanGateAnswer = z.infer<typeof PlanGateAnswerSchema>;

/** Wire response fragment under answers.plan. */
export const PlanGateSystemOneResponseSchema = z
  .object({
    answers: z
      .object({
        plan: PlanGateAnswerSchema,
      })
      .passthrough(),
  })
  .passthrough();

// --- Stub contracts for gates #3–5 (types only; not implemented this PR) ---

/**
 * Skill pick is dynamic later (full registry per agent). Do not hardcode allow-all.
 * This stub only shapes the future answer payload.
 */
export const SkillPickGateAnswerSchema = z
  .object({
    skill_ids: z.array(z.string().min(1)),
    confidence: z.number().min(0).max(1),
  })
  .strict();
export type SkillPickGateAnswer = z.infer<typeof SkillPickGateAnswerSchema>;

export const ReviewPrescreenAnswerSchema = z
  .object({
    choice: z.enum(["forward", "filter", "needs_human"]),
    confidence: z.number().min(0).max(1),
    filtered_paths: z.array(z.string()).optional(),
  })
  .strict();
export type ReviewPrescreenAnswer = z.infer<typeof ReviewPrescreenAnswerSchema>;

export const IntakeTriageAnswerSchema = z
  .object({
    choice: z.enum(["enqueue", "clarify", "reject", "needs_human"]),
    confidence: z.number().min(0).max(1),
    labels: z.array(z.string()).optional(),
  })
  .strict();
export type IntakeTriageAnswer = z.infer<typeof IntakeTriageAnswerSchema>;
