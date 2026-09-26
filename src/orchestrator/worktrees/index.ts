export {
  WorktreeIsolationError,
  WorktreeManager,
  worktreeKey,
  type CreateWorktreeOptions,
  type ReapResult,
  type WorktreeHandle,
  type WorktreeLifecycle,
  type WorktreeManagerOptions,
  type WorktreeReapOutcome,
} from "./manager.js";
export {
  createWorktreeStageHandler,
  type WorktreeStageStep,
  type WorktreeStageStepRunner,
} from "./stage-hooks.js";
