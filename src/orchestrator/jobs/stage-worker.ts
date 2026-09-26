/**
 * One Eve step for a BullMQ stage processor.
 * Call this from the worker. Do not enqueue the next stage here.
 * Cursor updates stay in `processStageJob` (`run-stage.ts`).
 */
import type { EveStepResult } from "../../eve/contract.js";
import { runEveStep, type EveRunOptions } from "../../eve/run-step.js";

export function runEveStageStep(data: unknown, options?: EveRunOptions): Promise<EveStepResult> {
  return runEveStep(data, options);
}
