/**
 * BullMQ implement/merge hooks for the worktree manager.
 * `processStageJob` applies these when `StageRuntime.worktrees` is set.
 * Implement prepares the checkout before `invoke_implementation`.
 * Merge failure calls `reap({ merged: false })` (retain unless configured otherwise).
 * `record_cleanup` calls `reap({ merged: true })` after the branch merge step succeeds.
 *
 * Skill seed/reap is {@link createSkillStageHook}, passed as `WorktreeManager`'s
 * `skillStageHook`. Create seeds when `stepId` is set; delete reaps `.agents/skills`.
 */
import type { StageStepResult } from "../jobs/stage-result.js";
import type { WorkflowSkillLoader } from "../skills/loader.js";
import type { WorktreeLifecycle, WorktreeSkillStageHook } from "./manager.js";

export interface WorktreeStageStep {
  taskId: string;
  stage: string;
  step: string;
  /** Workflow step whose skill budget is seeded into the new worktree. */
  workflowStepId?: string;
  plannerSelection?: readonly string[];
  /** Filled from `create` before the implement step handler runs. */
  worktreeId?: string;
  /** Catalog repo. Omitted uses the router default. */
  repoId?: string;
}

export interface WorktreeStageStepRunner<T extends WorktreeStageStep = WorktreeStageStep> {
  run(ctx: T): Promise<void | StageStepResult>;
}

const IMPLEMENT_CREATE_STEP = "invoke_implementation";
const MERGE_BRANCH_STEP = "merge_branch";
const MERGE_CLEANUP_STEP = "record_cleanup";

export function createWorktreeStageHandler<T extends WorktreeStageStep>(
  worktrees: WorktreeLifecycle,
  inner: WorktreeStageStepRunner<T>,
): WorktreeStageStepRunner<T> {
  return {
    async run(ctx) {
      if (ctx.stage === "implement" && ctx.step === IMPLEMENT_CREATE_STEP) {
        const handle = await worktrees.create(ctx.taskId, {
          stepId: ctx.workflowStepId,
          plannerSelection: ctx.plannerSelection,
          repoId: ctx.repoId,
        });
        if (!ctx.worktreeId) ctx.worktreeId = handle.worktreeId;
      }
      let result: void | StageStepResult;
      try {
        result = await inner.run(ctx);
      } catch (error) {
        if (ctx.stage === "merge" && ctx.step === MERGE_BRANCH_STEP) {
          await worktrees.reap(ctx.taskId, { merged: false });
        }
        throw error;
      }
      if (ctx.stage === "merge" && ctx.step === MERGE_CLEANUP_STEP) {
        await worktrees.reap(ctx.taskId, { merged: true });
      }
      return result;
    },
  };
}

/** Default skill stage hook: seed the step allow-list, reap it on delete. */
export function createSkillStageHook(loader: WorkflowSkillLoader): WorktreeSkillStageHook {
  return {
    async onCreate(ctx) {
      if (!ctx.stepId) return;
      const allowList = await loader.computeAllowList({
        stepId: ctx.stepId,
        plannerSelection: ctx.plannerSelection,
      });
      await loader.seed(ctx.worktreePath, allowList);
    },
    async onDelete(ctx) {
      await loader.reap(ctx.worktreePath);
    },
  };
}
