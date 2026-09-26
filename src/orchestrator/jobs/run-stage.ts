/**
 * Idempotent stage processor. Completed steps stay on the cursor; a crash retries the unfinished step.
 */
import type { ModelAdapter } from "../../agent/adapter.js";
import { runAgentLoop } from "../../agent/loop.js";
import type { StepCursor, StepCursorStore } from "./cursor.js";
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
}

export interface StageStepHandler {
  run(ctx: StageStepContext): Promise<void>;
}

export interface StageRuntime {
  cursors: StepCursorStore;
  handler: StageStepHandler;
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

export function createAgentStageHandler(adapter: ModelAdapter): StageStepHandler {
  return {
    async run(ctx) {
      await runAgentLoop({ prompt: `${ctx.stage}:${ctx.step} task=${ctx.taskId}` }, adapter);
    },
  };
}

export async function processStageJob(input: unknown, deps: StageRuntime): Promise<StageJobResult> {
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

  cursor = { ...cursor, status: "running", updatedAt: nowIso() };
  await deps.cursors.save(cursor);

  for (let index = cursor.nextStepIndex; index < steps.length; index += 1) {
    const step = steps[index];
    if (!step) {
      throw new Error(`missing step ${index} for ${payload.stage}`);
    }
    await deps.handler.run({
      taskId: payload.taskId,
      sessionId: payload.sessionId,
      stage: payload.stage,
      step,
      stepIndex: index,
    });
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
