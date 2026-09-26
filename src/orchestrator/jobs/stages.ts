/**
 * Pipeline stages for the default task graph (workflows/default-task.yaml, SPEC §14.0).
 * Execution order is plan → implement → review → ready → merge.
 */
import { z } from "zod";

export const PIPELINE_STAGES = ["plan", "implement", "review", "ready", "merge"] as [
  "plan",
  "implement",
  "review",
  "ready",
  "merge",
];

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export const STAGE_QUEUES: Record<PipelineStage, string> = {
  plan: "optio.plan",
  implement: "optio.implement",
  review: "optio.review",
  ready: "optio.ready",
  merge: "optio.merge",
};

/** Intra-stage steps. A crash resumes at the first step that was not persisted. */
export const STAGE_STEPS: Record<PipelineStage, readonly [string, string]> = {
  plan: ["ack_session", "invoke_planner"],
  implement: ["invoke_implementation", "record_diff"],
  review: ["invoke_review", "record_verdict"],
  ready: ["open_pr", "record_ci_wait"],
  merge: ["merge_branch", "record_cleanup"],
};

export const PIPELINE_JOB_ATTEMPTS = 5;

/** BullMQ custom job ids cannot contain `:`. */
const PipelineIdSchema = z
  .string()
  .min(1)
  .regex(/^[^:]+$/, "must not contain ':'");

export const PipelineIdentitySchema = z.object({
  taskId: PipelineIdSchema,
  sessionId: PipelineIdSchema,
});

export type PipelineIdentity = z.infer<typeof PipelineIdentitySchema>;

export const StageJobPayloadSchema = PipelineIdentitySchema.extend({
  stage: z.enum(PIPELINE_STAGES),
  /** Intake title. Present on jobs enqueued by POST /intake. */
  title: z.string().min(1).optional(),
  /** Intake description. Omitted when the brief has none. */
  description: z.string().optional(),
  /** Catalog repo for worktree routing. Omitted uses the catalog default at create time. */
  repoId: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "repoId must be a safe token")
    .optional(),
});

export type StageJobPayload = z.infer<typeof StageJobPayloadSchema>;

export function previousStage(stage: PipelineStage): PipelineStage | undefined {
  const index = PIPELINE_STAGES.indexOf(stage);
  return index > 0 ? PIPELINE_STAGES[index - 1] : undefined;
}
