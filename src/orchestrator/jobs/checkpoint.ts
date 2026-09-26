/**
 * Stage checkpoint derived from the step cursor.
 * A restarted orchestrator resumes at `resumeStage` and does not repeat `lastCompletedStage`.
 */
import type { StepCursorStore } from "./cursor.js";
import { PIPELINE_STAGES, type PipelineStage } from "./stages.js";

export interface StageCheckpoint {
  taskId: string;
  sessionId: string;
  lastCompletedStage: PipelineStage | null;
  /** First stage whose cursor is missing or not `completed`. Null when every stage finished. */
  resumeStage: PipelineStage | null;
}

export async function readStageCheckpoint(
  cursors: StepCursorStore,
  taskId: string,
  sessionId: string,
): Promise<StageCheckpoint> {
  let lastCompletedStage: PipelineStage | null = null;
  for (const stage of PIPELINE_STAGES) {
    const cursor = await cursors.get(taskId, sessionId, stage);
    if (!cursor || cursor.status !== "completed") {
      return { taskId, sessionId, lastCompletedStage, resumeStage: stage };
    }
    lastCompletedStage = stage;
  }
  return { taskId, sessionId, lastCompletedStage, resumeStage: null };
}
