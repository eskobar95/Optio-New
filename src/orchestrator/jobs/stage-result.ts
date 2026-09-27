/**
 * What a stage step may report back to the BullMQ processor.
 * Agent steps report token/USD usage and, for the planner, a confidence in [0, 1].
 */

export interface StageStepUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface StageStepResult {
  usage?: StageStepUsage;
  /** Planner confidence in [0, 1]. Missing or out of range does not auto-approve. */
  confidence?: number;
  /** Planner text stored on the plan artifact. */
  summary?: string;
  /** Pull request URL stored on the stage artifact. */
  prUrl?: string;
  /** Hannes passed on this head. The merge gate records a policy approval. */
  reviewApproved?: boolean;
}

const STEP_USAGE = Symbol.for("optio.stageStepUsage");

/** Attach reported usage to a thrown step error so the budget ledger can still count it. */
export function attachStepUsage(error: unknown, usage: StageStepUsage | undefined): void {
  if (!usage || !error || typeof error !== "object") return;
  Object.defineProperty(error, STEP_USAGE, { value: usage, enumerable: false });
}

export function readAttachedUsage(error: unknown): StageStepUsage | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as Record<symbol, unknown>)[STEP_USAGE];
  if (!value || typeof value !== "object") return undefined;
  return value as StageStepUsage;
}
