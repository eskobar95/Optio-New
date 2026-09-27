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
import { redact } from "../github/pull-request.js";
import type { StageRunLog, StageUsageReport } from "../observability/run-log.js";
import { redactSecrets } from "../../security/redact.js";
import type { WorktreeLifecycle } from "../worktrees/manager.js";
import { createWorktreeStageHandler } from "../worktrees/stage-hooks.js";
import {
  artifactCutoffIso,
  buildSessionArtifact,
  readArtifactLimits,
  type ArtifactLimits,
  type SessionArtifactStore,
} from "../artifacts/index.js";
import {
  accountBudgetAfterRun,
  assertBudgetBeforeRun,
  isBudgetedAgentStep,
  reportedUsage,
  type BudgetBinding,
} from "./budget.js";
import type { StepCursor, StepCursorStore } from "./cursor.js";
import { logStageEvent } from "./stage-log.js";
import {
  ApprovalRequiredError,
  assertNoTerminalHitl,
  approveMergeForReviewAgent,
  enforceHitlGate,
  releaseReplanAfterPlan,
  type HitlBinding,
} from "./hitl.js";
import {
  ReviewGateClosedError,
  evaluateReviewGate,
  type ReviewGateBinding,
} from "./review-gate.js";
import { readAttachedUsage, type StageStepResult, type StageStepUsage } from "./stage-result.js";
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
  /** Intake title, when the stage job carried it. */
  title?: string;
  /** Intake description, when the stage job carried it. */
  description?: string;
  /** Records adapter usage for this stage when the adapter exposed token or cost figures. */
  recordUsage?: (usage: StageUsageReport) => Promise<void>;
  /** Catalog repo for worktree create. */
  repoId?: string;
  /** Intake source. Linear tasks drive the board workflow. */
  source?: "http" | "github" | "slack" | "linear";
  /** Linear issue UUID when source is linear. */
  linearIssueId?: string;
}

export interface StageStepHandler {
  run(ctx: StageStepContext): Promise<void | StageStepResult>;
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
  /**
   * When set, implement waits on plan approval and merge waits before merge_branch.
   * Ready (open_pr, record_ci_wait) is not paused. A required gate never approves on timeout.
   */
  hitl?: HitlBinding;
  /** When set, agent steps fail closed with BudgetExceeded once a cap is exceeded. */
  budget?: BudgetBinding;
  /** When set, each stage writes one artifact row (plan, PR link, outcome, last error). */
  artifacts?: SessionArtifactStore;
  /** Caps and retention for {@link artifacts}. Defaults from the environment. */
  artifactLimits?: ArtifactLimits;
  /** When set, review-gate and implementation failures are fingerprinted. */
  learning?: LearningSink;
  /** When set, stage timing, failures, usage, and step actions are stored for the task. */
  runLog?: StageRunLog;
  /** Clock for stage timing. Defaults to `Date`. */
  now?: () => Date;
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
      const result = await tracer.runStage(
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
      if (ctx.recordUsage && result.usage) {
        await ctx.recordUsage({
          agentId: `agents/${ctx.stage}`,
          provider: result.usage.provider,
          modelId: result.usage.model_id,
          inputTokens: result.usage.input_tokens,
          outputTokens: result.usage.output_tokens,
          cachedTokens: result.usage.cached_tokens,
          costUsd: result.usage.cost_usd,
        });
      }
      const stepResult: StageStepResult = {};
      const mappedUsage = result.usage ? stepUsageFromModel(result.usage) : undefined;
      if (mappedUsage) stepResult.usage = mappedUsage;
      if (result.confidence !== undefined) stepResult.confidence = result.confidence;
      if (ctx.stage === "plan" && ctx.step === "invoke_planner" && result.text.trim()) {
        stepResult.summary = result.text;
      }
      return stepResult;
    },
  };
}

function logStage(level: "log" | "error", body: Record<string, unknown>): void {
  logStageEvent(body, level === "error" ? console.error : console.log);
}

async function safeRunLog<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const reason = redactSecrets(error instanceof Error ? error.message : "run log failed");
    logStage("error", { msg: "stage.run_log_failed", reason });
    return fallback;
  }
}

function errorReason(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

/** Map adapter snake_case usage onto the camelCase ledger. Absent fields stay absent. */
function stepUsageFromModel(usage: {
  input_tokens?: number;
  output_tokens?: number;
  cost_usd?: number;
}): StageStepUsage | undefined {
  const reported: StageStepUsage = {};
  if (typeof usage.input_tokens === "number") reported.inputTokens = usage.input_tokens;
  if (typeof usage.output_tokens === "number") reported.outputTokens = usage.output_tokens;
  if (typeof usage.cost_usd === "number") reported.costUsd = usage.cost_usd;
  return Object.keys(reported).length > 0 ? reported : undefined;
}

function scrubArtifactText(text: string): string {
  const secrets = [
    process.env.OPTIO_NEW_GITHUB_TOKEN,
    process.env.CURSOR_API_KEY,
    process.env.MODEL_API_KEY,
    process.env.OPTIO_NEW_DATABASE_URL,
    process.env.OPTIO_NEW_INTAKE_WEBHOOK_SECRET,
  ].filter((value): value is string => Boolean(value?.trim()));
  return redact(text, secrets);
}

function planTextFor(payload: StageJobPayload, summary: string | null): string | null {
  if (payload.stage !== "plan") return null;
  const parts = [payload.title?.trim(), payload.description?.trim(), summary?.trim()].filter(
    (part): part is string => Boolean(part),
  );
  return parts.length > 0 ? parts.join("\n\n") : null;
}

async function recordStageArtifact(
  deps: StageRuntime,
  payload: StageJobPayload,
  outcome: "completed" | "failed",
  details: { planText: string | null; prUrl: string | null; errorMessage: string | null },
): Promise<void> {
  if (!deps.artifacts) return;
  const limits = deps.artifactLimits ?? readArtifactLimits();
  const artifact = buildSessionArtifact({
    taskId: payload.taskId,
    sessionId: payload.sessionId,
    stage: payload.stage,
    outcome,
    planText: details.planText,
    prUrl: details.prUrl,
    errorMessage: details.errorMessage ? scrubArtifactText(details.errorMessage) : null,
    updatedAt: nowIso(),
    limits,
  });
  try {
    await deps.artifacts.upsert(artifact);
    await deps.artifacts.prune(artifactCutoffIso(limits.retentionDays), limits.maxRows);
  } catch (error) {
    const message = error instanceof Error ? error.message : "artifact write failed";
    console.error(
      JSON.stringify({ msg: "session artifact write failed", error: scrubArtifactText(message) }),
    );
    if (outcome === "completed") throw error;
  }
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
    logStageEvent({ msg: "learning record failed", error: message }, console.error);
  }
}

async function lookupWorktreeId(taskId: string, deps: StageRuntime): Promise<string> {
  if (deps.worktreeId) return deps.worktreeId;
  if (!taskId || !deps.worktrees?.status) return "";
  const handle = await deps.worktrees.status(taskId);
  return handle?.worktreeId ?? "";
}

export async function processStageJob(input: unknown, deps: StageRuntime): Promise<StageJobResult> {
  const tracer = deps.tracer ?? getStageTracer();
  const stage = readStringField(input, "stage");
  const sessionId = readStringField(input, "sessionId");
  const taskId = readStringField(input, "taskId");
  const worktreeId = await lookupWorktreeId(taskId, deps);
  return tracer.runStage(
    CANONICAL_SPAN.workflowStep,
    {
      taskId,
      worktreeId,
      attributes: {
        workflow_id: "default-task",
        ...(stage ? { step_id: stage } : {}),
        ...(sessionId ? { session_id: sessionId } : {}),
      },
    },
    () => executeStageJob(input, deps, tracer, worktreeId),
  );
}

async function executeStageJob(
  input: unknown,
  deps: StageRuntime,
  tracer: StageTracer,
  worktreeId: string,
): Promise<StageJobResult> {
  const payload = StageJobPayloadSchema.parse(input);
  const clock = deps.now ?? (() => new Date());
  const runLog = deps.runLog;
  let timingOpen = false;
  let startedMs = 0;
  let activeStep: string | undefined;
  let failureRecorded = false;
  let planSummary: string | null = null;
  let prUrl: string | null = null;

  const identity = {
    taskId: payload.taskId,
    sessionId: payload.sessionId,
    stage: payload.stage,
  };

  async function openTiming(): Promise<void> {
    if (timingOpen) return;
    timingOpen = true;
    const stamped = clock();
    let startedAt = stamped.toISOString();
    if (runLog) {
      const begun = await safeRunLog(() => runLog.beginStage({ ...identity, startedAt }), {
        startedAt,
      });
      startedAt = begun.startedAt;
    }
    startedMs = Date.parse(startedAt);
  }

  async function recordFailure(error: unknown, step?: string): Promise<void> {
    if (failureRecorded) return;
    failureRecorded = true;
    await openTiming();
    const ended = clock();
    const reason = errorReason(error);
    const durationMs = ended.getTime() - startedMs;
    if (runLog && step) {
      await safeRunLog(
        () =>
          runLog.recordAction({
            ...identity,
            step,
            agentId: `agents/${payload.stage}`,
            name: step,
            status: "error",
            reason,
            at: ended.toISOString(),
          }),
        undefined,
      );
    }
    if (runLog) {
      await safeRunLog(
        () =>
          runLog.finishStage({
            ...identity,
            endedAt: ended.toISOString(),
            durationMs,
            status: "failed",
            reason,
          }),
        undefined,
      );
    }
    logStage("error", {
      msg: "stage.failed",
      ...identity,
      ...(step ? { step } : {}),
      reason,
      startedAt: new Date(startedMs).toISOString(),
      endedAt: ended.toISOString(),
      durationMs,
    });
  }

  try {
    if (deps.hitl) {
      await assertNoTerminalHitl(payload.stage, deps.hitl, payload);
    }
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

    await openTiming();

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
        await recordStageArtifact(deps, payload, "failed", {
          planText: null,
          prUrl: null,
          errorMessage: decision.reason,
        });
        throw new ReviewGateClosedError(decision);
      }
    }

    if (deps.hitl) {
      await enforceHitlGate(payload.stage, deps.hitl, payload);
    }

    cursor = { ...cursor, status: "running", updatedAt: nowIso() };
    await deps.cursors.save(cursor);

    const handler: StageStepHandler = deps.worktrees
      ? createWorktreeStageHandler(deps.worktrees, deps.handler)
      : deps.handler;

    let activeWorktreeId = worktreeId;
    for (let index = cursor.nextStepIndex; index < steps.length; index += 1) {
      const step = steps[index];
      if (!step) {
        throw new Error(`missing step ${index} for ${payload.stage}`);
      }
      activeStep = step;
      const ctx: StageStepContext = {
        taskId: payload.taskId,
        sessionId: payload.sessionId,
        stage: payload.stage,
        step,
        stepIndex: index,
        worktreeId: activeWorktreeId || undefined,
        tracer,
        title: payload.title,
        description: payload.description,
        repoId: payload.repoId,
        source: payload.source,
        linearIssueId: payload.linearIssueId,
        recordUsage: async (usage) => {
          if (!runLog) return;
          await safeRunLog(() => runLog.recordUsage({ ...identity, ...usage }), undefined);
        },
      };
      if (deps.budget && isBudgetedAgentStep(step)) {
        await assertBudgetBeforeRun(deps.budget, ctx);
      }
      let result: void | StageStepResult;
      try {
        result = await handler.run(ctx);
      } catch (error) {
        if (deps.budget && isBudgetedAgentStep(step)) {
          const attached = readAttachedUsage(error);
          if (attached && reportedUsage(deps.budget.caps, payload.stage, attached)) {
            await accountBudgetAfterRun(deps.budget, ctx, attached);
          }
        }
        const message = error instanceof Error ? error.message : "stage failed";
        cursor = { ...cursor, status: "failed", updatedAt: nowIso() };
        try {
          await deps.cursors.save(cursor);
        } catch (saveError) {
          const saveMessage = saveError instanceof Error ? saveError.message : "cursor save failed";
          logStage("error", {
            msg: "step cursor failed-status write failed",
            error: saveMessage,
          });
        }
        await recordStageArtifact(deps, payload, "failed", {
          planText: planTextFor(payload, planSummary),
          prUrl,
          errorMessage: message,
        });
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
      if (result?.reviewApproved && deps.hitl) {
        await approveMergeForReviewAgent(deps.hitl, {
          taskId: payload.taskId,
          sessionId: payload.sessionId,
        });
      }
      if (deps.hitl && step === "invoke_planner" && result && result.confidence !== undefined) {
        await deps.hitl.signals.note({
          taskId: payload.taskId,
          sessionId: payload.sessionId,
          point: "plan",
          confidence: result.confidence,
        });
      }
      if (deps.budget && isBudgetedAgentStep(step)) {
        await accountBudgetAfterRun(deps.budget, ctx, result?.usage);
      }
      if (payload.stage === "plan" && step === "invoke_planner" && result?.summary?.trim()) {
        planSummary = result.summary;
      }
      if (result?.prUrl?.trim()) prUrl = result.prUrl;
      if (ctx.worktreeId) activeWorktreeId = ctx.worktreeId;
      const actedAt = clock();
      if (runLog) {
        await safeRunLog(
          () =>
            runLog.recordAction({
              ...identity,
              step,
              agentId: `agents/${payload.stage}`,
              name: step,
              status: "ok",
              at: actedAt.toISOString(),
            }),
          undefined,
        );
      }
      activeStep = undefined;
      const finished = index + 1 >= steps.length;
      if (finished) {
        await recordStageArtifact(deps, payload, "completed", {
          planText: planTextFor(payload, planSummary),
          prUrl,
          errorMessage: null,
        });
      }
      cursor = {
        ...cursor,
        nextStepIndex: index + 1,
        status: finished ? "completed" : "running",
        updatedAt: nowIso(),
      };
      await deps.cursors.save(cursor);
    }

    if (deps.hitl && payload.stage === "plan") {
      await releaseReplanAfterPlan(deps.hitl, payload);
    }

    const ended = clock();
    const durationMs = ended.getTime() - startedMs;
    const startedAt = new Date(startedMs).toISOString();
    const endedAt = ended.toISOString();
    if (runLog) {
      await safeRunLog(
        () =>
          runLog.finishStage({
            ...identity,
            endedAt,
            durationMs,
            status: "completed",
          }),
        undefined,
      );
    }
    logStage("log", {
      msg: "stage.completed",
      ...identity,
      startedAt,
      endedAt,
      durationMs,
    });

    return {
      taskId: payload.taskId,
      sessionId: payload.sessionId,
      stage: payload.stage,
      status: "completed",
      nextStepIndex: steps.length,
    };
  } catch (error) {
    if (!(error instanceof ApprovalRequiredError)) {
      await recordFailure(error, activeStep);
    }
    throw error;
  }
}

export async function runPipeline(
  input: { taskId: string; sessionId: string; repoId?: string },
  deps: StageRuntime,
): Promise<PipelineRunResult> {
  const stages: StageJobResult[] = [];
  for (const stage of PIPELINE_STAGES) {
    stages.push(await processStageJob({ ...input, stage }, deps));
  }
  return { stages };
}
