/**
 * BullMQ implement/merge hooks for the worktree manager.
 * `processStageJob` applies these when `StageRuntime.worktrees` is set.
 * Implement prepares the checkout before `invoke_implementation`.
 * Merge failure calls `reap({ merged: false })` (retain unless configured otherwise).
 * `record_cleanup` calls `reap({ merged: true })` after the branch merge step succeeds.
 */
import type { WorktreeLifecycle } from "./manager.js";

export interface WorktreeStageStep {
  taskId: string;
  stage: string;
  step: string;
}

export interface WorktreeStageStepRunner<T extends WorktreeStageStep = WorktreeStageStep> {
  run(ctx: T): Promise<void>;
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
        await worktrees.create(ctx.taskId);
      }
      try {
        await inner.run(ctx);
      } catch (error) {
        if (ctx.stage === "merge" && ctx.step === MERGE_BRANCH_STEP) {
          await worktrees.reap(ctx.taskId, { merged: false });
        }
        throw error;
      }
      if (ctx.stage === "merge" && ctx.step === MERGE_CLEANUP_STEP) {
        await worktrees.reap(ctx.taskId, { merged: true });
      }
    },
  };
}
