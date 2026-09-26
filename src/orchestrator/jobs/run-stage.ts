/**
 * Idempotent stage processor. Completed steps stay on the cursor; a crash retries the unfinished step.
 */
import type { ModelAdapter } from "../../agent/adapter.js";
import { runAgentLoop, type SkillLoader } from "../../agent/loop.js";
import {
  formatPlannerLearnings,
  observationFromHandlerFailure,
  observationFromReviewGate,
  type LearningRecord,
} from "../learning/index.js";
import type { LearningSink } from "../learning/observation.js";
import {
  CANONICAL_SPAN,
  getStageTracer,
  readStringField,
  type StageTracer,
} from "../telemetry/index.js";
import type { WorktreeLifecycle } from "../worktrees/manager.js";
import { createWorktreeStageHandler } from "../worktrees/stage-hooks.js";
import type { StepCursor, StepCursorStore } from "./cursor.js";
import {
  ReviewGateClosedError,
  evaluateReviewGate,
  type ReviewGateBinding,
} from "./review-gate.js";
import {
  PIPELINE_STAGES,
  STAGE_STEPS,
  StageJobPayloadSchema,
  previousStage,
  type PipelineStage,
  type StageJobPayload,
} from "./stages.js";

export class StageNotReadyError extends Error {
  readonly stage: PipelineStage;
  readonly blockedBy: PipelineStage;

  constructor(stage: PipelineStage, blockedBy: PipelineStage) {
    super(`stage ${stage} waits on ${blockedBy}`);
    this.name = "StageNotReadyError";
    this.stage = stage;
    this.blockedBy = blockedBy;
  }
}

export interface StageStepContext {
  taskId: string;
  sessionId: string;
  stage: PipelineStage;
  step: string;
  stepIndex: number;
  worktreeId?: string;
  tracer?: StageTracer;
}

export interface StageStepHandler {
  run(ctx: StageStepContext): Promise<void>;
}

export interface StageRuntime {
  cursors: StepCursorStore;
  handler: StageStepHandler;
  /**
   * When set, ready starts only after the review gate passes.
   * A closed gate throws {@link ReviewGateClosedError} and does not write the ready cursor.
   */
  reviewGate?: ReviewGateBinding;
  /** When set, implement creates the task worktree and merge reaps it. */
  worktrees?: WorktreeLifecycle;
  /** When set, stage and agent spans share this tracer. */
  tracer?: StageTracer;
  /** Empty string on the span when omitted (no worktree yet). */
  worktreeId?: string;
  /** When set, review-gate and implementation failures are fingerprinted. */
  learning?: LearningSink;
  learningContext?: {
    workflowId?: string;
    field?: string;
    skillIds?: readonly string[];
    specialistIds?: readonly string[];
  };
}

export interface StageLearningReader {
  listForPlan(ctx: StageStepContext): Promise<LearningRecord[]>;
}

export interface StageJobResult {
  taskId: string;
  sessionId: string;
  stage: PipelineStage;
  status: "completed";
  nextStepIndex: number;
}

export interface PipelineRunResult {
  stages: StageJobResult[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function freshCursor(payload: StageJobPayload): StepCursor {
  return {
    taskId: payload.taskId,
    sessionId: payload.sessionId,
    stage: payload.stage,
    nextStepIndex: 0,
    status: "pending",
    updatedAt: nowIso(),
  };
}

export function createAgentStageHandler(
  adapter: ModelAdapter,
  options?: { learnings?: StageLearningReader; skillLoader?: SkillLoader },
): StageStepHandler {
  return {
    async run(ctx) {
      const tracer = ctx.tracer ?? getStageTracer();
      let prompt = `${ctx.stage}:${ctx.step} task=${ctx.taskId}`;
      if (ctx.stage === "plan" && ctx.step === "invoke_planner" && options?.learnings) {
        const records = await options.learnings.listForPlan(ctx);
        const block = formatPlannerLearnings(records);
        if (block) prompt = `${prompt}\n\n${block}`;
      }
      await tracer.runStage(
        CANONICAL_SPAN.agentRun,
        {
          taskId: ctx.taskId,
          worktreeId: ctx.worktreeId,
          attributes: {
            workflow_id: "default-task",
            step_id: ctx.step,
            agent_id: `agents/${ctx.stage}`,
            session_id: ctx.sessionId,
          },
        },
        () =>
          runAgentLoop(
            {
              prompt,
              taskId: ctx.taskId,
              worktreeId: ctx.worktreeId,
              stepId: ctx.step,
              tracer,
            },
            adapter,
            options?.skillLoader,
          ),
      );
    },
  };
}

async function recordLearning(
  sink: LearningSink | undefined,
  observation: Parameters<LearningSink["record"]>[0],
): Promise<void> {
  if (!sink) return;
  try {
    await sink.record(observation);
  } catch (error) {
    const message = error instanceof Error ? error.message : "learning record failed";
    console.error(`[optio.learn] ${message}`);
  }
}

export async function processStageJob(input: unknown, deps: StageRuntime): Promise<StageJobResult> {
  const tracer = deps.tracer ?? getStageTracer();
  const stage = readStringField(input, "stage");
  const sessionId = readStringField(input, "sessionId");
  return tracer.runStage(
    CANONICAL_SPAN.workflowStep,
    {
      taskId: readStringField(input, "taskId"),
      worktreeId: deps.worktreeId,
      attributes: {
        workflow_id: "default-task",
        ...(stage ? { step_id: stage } : {}),
        ...(sessionId ? { session_id: sessionId } : {}),
      },
    },
    () => executeStageJob(input, deps, tracer),
  );
}

async function executeStageJob(
  input: unknown,
  deps: StageRuntime,
  tracer: StageTracer,
): Promise<StageJobResult> {
  const payload = StageJobPayloadSchema.parse(input);
  const blockedBy = previousStage(payload.stage);
  if (blockedBy) {
    const previous = await deps.cursors.get(payload.taskId, payload.sessionId, blockedBy);
    if (!previous || previous.status !== "completed") {
      throw new StageNotReadyError(payload.stage, blockedBy);
    }
  }

  const steps = STAGE_STEPS[payload.stage];
  let cursor =
    (await deps.cursors.get(payload.taskId, payload.sessionId, payload.stage)) ??
    freshCursor(payload);

  if (cursor.status === "completed" || cursor.nextStepIndex >= steps.length) {
    const completed: StepCursor = {
      ...cursor,
      status: "completed",
      nextStepIndex: steps.length,
      updatedAt: nowIso(),
    };
    if (cursor.status !== "completed" || cursor.nextStepIndex !== steps.length) {
      await deps.cursors.save(completed);
    }
    return {
      taskId: payload.taskId,
      sessionId: payload.sessionId,
      stage: payload.stage,
      status: "completed",
      nextStepIndex: steps.length,
    };
  }

  if (payload.stage === "ready" && deps.reviewGate) {
    const evidence = await deps.reviewGate.loadEvidence({
      taskId: payload.taskId,
      sessionId: payload.sessionId,
    });
    const decision = await evaluateReviewGate(evidence, deps.reviewGate.advisor);
    if (decision.verdict !== "pass") {
      await recordLearning(
        deps.learning,
        observationFromReviewGate({
          taskId: payload.taskId,
          sessionId: payload.sessionId,
          reason: decision.reason,
          attempt: decision.attempt,
          reviewNotes: decision.review_notes,
          field: evidence?.field,
          skillIds: evidence?.skill_ids,
          specialistIds: evidence?.specialist_ids,
          workflowId: evidence?.workflow_id,
        }),
      );
      throw new ReviewGateClosedError(decision);
    }
  }

  cursor = { ...cursor, status: "running", updatedAt: nowIso() };
  await deps.cursors.save(cursor);

  const handler: StageStepHandler = deps.worktrees
    ? createWorktreeStageHandler(deps.worktrees, deps.handler)
    : deps.handler;

  for (let index = cursor.nextStepIndex; index < steps.length; index += 1) {
    const step = steps[index];
    if (!step) {
      throw new Error(`missing step ${index} for ${payload.stage}`);
    }
    try {
      await handler.run({
        taskId: payload.taskId,
        sessionId: payload.sessionId,
        stage: payload.stage,
        step,
        stepIndex: index,
        worktreeId: deps.worktreeId,
        tracer,
      });
    } catch (error) {
      if (payload.stage === "implement" || payload.stage === "review") {
        await recordLearning(
          deps.learning,
          observationFromHandlerFailure({
            taskId: payload.taskId,
            sessionId: payload.sessionId,
            stage: payload.stage,
            step,
            error,
            field: deps.learningContext?.field,
            skillIds: deps.learningContext?.skillIds,
            specialistIds: deps.learningContext?.specialistIds,
            workflowId: deps.learningContext?.workflowId,
          }),
        );
      }
      throw error;
    }
    const finished = index + 1 >= steps.length;
    cursor = {
      ...cursor,
      nextStepIndex: index + 1,
      status: finished ? "completed" : "running",
      updatedAt: nowIso(),
    };
    await deps.cursors.save(cursor);
  }

  return {
    taskId: payload.taskId,
    sessionId: payload.sessionId,
    stage: payload.stage,
    status: "completed",
    nextStepIndex: steps.length,
  };
}

export async function runPipeline(
  input: { taskId: string; sessionId: string },
  deps: StageRuntime,
): Promise<PipelineRunResult> {
  const stages: StageJobResult[] = [];
  for (const stage of PIPELINE_STAGES) {
    stages.push(await processStageJob({ ...input, stage }, deps));
  }
  return { stages };
}
