/**
 * Jev gate sequence contracts (ENG-25).
 * Gates #1–5 implemented (soft fail-open).
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

// --- Gate #3 — dynamic skill / MCP pick ---

/**
 * Allow-list is the **maximum** permission set (full registry visible to the agent).
 * Jev selects a per-task subset — never hardcode allow-all into context.
 */
export const DEFAULT_SKILL_PICK_MIN_CONFIDENCE = 0.7;
export const DEFAULT_SKILL_PICK_TIMEOUT_MS = 30_000;

export const SkillPickGateConfigSchema = z
  .object({
    minConfidence: z.number().min(0).max(1).default(DEFAULT_SKILL_PICK_MIN_CONFIDENCE),
    timeoutMs: z.number().int().positive().default(DEFAULT_SKILL_PICK_TIMEOUT_MS),
    passthroughOnTimeout: z.boolean().default(true),
  })
  .strict();
export type SkillPickGateConfig = z.infer<typeof SkillPickGateConfigSchema>;

export const SkillPickGateStateSchema = z
  .object({
    task_id: z.string().optional(),
    workflow_id: z.string().optional(),
    step_id: z.string().optional(),
    stage: z.string().optional(),
    prompt: z.string().optional(),
    task_type: z.string().optional(),
    /** Full skill registry (allow-list max) visible to the picker. */
    skill_registry: z.array(z.string().min(1)).optional(),
    /** Full MCP capability / tool registry (allow-list max). */
    mcp_registry: z.array(z.string().min(1)).optional(),
    issue_title: z.string().optional(),
    issue_body: z.string().optional(),
  })
  .passthrough();
export type SkillPickGateState = z.infer<typeof SkillPickGateStateSchema>;

export const SkillPickGateAnswerSchema = z
  .object({
    skill_ids: z.array(z.string().min(1)),
    mcp_tool_ids: z.array(z.string().min(1)).optional(),
    confidence: z.number().min(0).max(1),
    notes: z.string().optional(),
  })
  .strict();
export type SkillPickGateAnswer = z.infer<typeof SkillPickGateAnswerSchema>;

/** Wire response fragment under answers.skill_pick. */
export const SkillPickGateSystemOneResponseSchema = z
  .object({
    answers: z
      .object({
        skill_pick: SkillPickGateAnswerSchema,
      })
      .passthrough(),
  })
  .passthrough();

// --- Gate #4 — review pre-screen (before Hannes) ---

/** Gate #4 labels — score/filter diffs before the review agent. */
export const ReviewPrescreenLabelSchema = z.enum(["forward", "filter", "needs_human"]);
export type ReviewPrescreenLabel = z.infer<typeof ReviewPrescreenLabelSchema>;

export const DEFAULT_REVIEW_PRESCREEN_MIN_CONFIDENCE = 0.7;
export const DEFAULT_REVIEW_PRESCREEN_TIMEOUT_MS = 30_000;

export const ReviewPrescreenConfigSchema = z
  .object({
    minConfidence: z.number().min(0).max(1).default(DEFAULT_REVIEW_PRESCREEN_MIN_CONFIDENCE),
    timeoutMs: z.number().int().positive().default(DEFAULT_REVIEW_PRESCREEN_TIMEOUT_MS),
    passthroughOnTimeout: z.boolean().default(true),
  })
  .strict();
export type ReviewPrescreenConfig = z.infer<typeof ReviewPrescreenConfigSchema>;

export const ReviewPrescreenStateSchema = z
  .object({
    task_id: z.string().optional(),
    workflow_id: z.string().optional(),
    step_id: z.string().optional(),
    /** Changed paths in the PR / worktree diff (allow-list max for filtering). */
    diff_paths: z.array(z.string().min(1)).optional(),
    diff_summary: z.string().optional(),
    issue_title: z.string().optional(),
    issue_body: z.string().optional(),
    task_type: z.string().optional(),
  })
  .passthrough();
export type ReviewPrescreenState = z.infer<typeof ReviewPrescreenStateSchema>;

export const ReviewPrescreenAnswerSchema = z
  .object({
    choice: ReviewPrescreenLabelSchema,
    confidence: z.number().min(0).max(1),
    /** Subset of diff_paths when choice is `filter`. */
    filtered_paths: z.array(z.string()).optional(),
    notes: z.string().optional(),
  })
  .strict();
export type ReviewPrescreenAnswer = z.infer<typeof ReviewPrescreenAnswerSchema>;

/** Wire response fragment under answers.review_prescreen. */
export const ReviewPrescreenSystemOneResponseSchema = z
  .object({
    answers: z
      .object({
        review_prescreen: ReviewPrescreenAnswerSchema,
      })
      .passthrough(),
  })
  .passthrough();

// --- Gate #5 — intake triage (Linear status-change path) ---

/** Gate #5 labels — classify intake before enqueue. */
export const IntakeTriageLabelSchema = z.enum(["enqueue", "clarify", "reject", "needs_human"]);
export type IntakeTriageLabel = z.infer<typeof IntakeTriageLabelSchema>;

export const DEFAULT_INTAKE_TRIAGE_MIN_CONFIDENCE = 0.7;
export const DEFAULT_INTAKE_TRIAGE_TIMEOUT_MS = 30_000;

export const IntakeTriageConfigSchema = z
  .object({
    minConfidence: z.number().min(0).max(1).default(DEFAULT_INTAKE_TRIAGE_MIN_CONFIDENCE),
    timeoutMs: z.number().int().positive().default(DEFAULT_INTAKE_TRIAGE_TIMEOUT_MS),
    passthroughOnTimeout: z.boolean().default(true),
  })
  .strict();
export type IntakeTriageConfig = z.infer<typeof IntakeTriageConfigSchema>;

export const IntakeTriageStateSchema = z
  .object({
    task_id: z.string().optional(),
    workflow_id: z.string().optional(),
    step_id: z.string().optional(),
    issue_title: z.string().optional(),
    issue_body: z.string().optional(),
    issue_identifier: z.string().optional(),
    source: z.string().optional(),
    team_key: z.string().optional(),
    to_status: z.string().optional(),
    task_type: z.string().optional(),
  })
  .passthrough();
export type IntakeTriageState = z.infer<typeof IntakeTriageStateSchema>;

export const IntakeTriageAnswerSchema = z
  .object({
    choice: IntakeTriageLabelSchema,
    confidence: z.number().min(0).max(1),
    labels: z.array(z.string()).optional(),
    notes: z.string().optional(),
  })
  .strict();
export type IntakeTriageAnswer = z.infer<typeof IntakeTriageAnswerSchema>;

/** Wire response fragment under answers.intake. */
export const IntakeTriageSystemOneResponseSchema = z
  .object({
    answers: z
      .object({
        intake: IntakeTriageAnswerSchema,
      })
      .passthrough(),
  })
  .passthrough();
