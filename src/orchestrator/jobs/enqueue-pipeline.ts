/**
 * New Bot intake → BullMQ flow. Validation stays in buildIntakeJob; this only enqueues.
 */
import type { FlowJob } from "bullmq";
import { buildIntakeJob } from "../intake/enqueue.js";
import {
  CANONICAL_SPAN,
  getStageTracer,
  readStringField,
  type StageTracer,
} from "../telemetry/index.js";
import { buildPipelineFlow } from "./flow.js";

export interface FlowEnqueuer {
  add(flow: FlowJob): Promise<unknown>;
}

export async function enqueueIntakePipeline(
  input: unknown,
  enqueuer: FlowEnqueuer,
  sessionId?: string,
  tracer: StageTracer = getStageTracer(),
): Promise<{ taskId: string; sessionId: string; flow: FlowJob }> {
  return tracer.runStage(
    CANONICAL_SPAN.intakeWebhook,
    { taskId: readStringField(input, "taskId"), worktreeId: "" },
    async (span) => {
      const task = buildIntakeJob(input);
      const identity = { taskId: task.taskId, sessionId: sessionId ?? task.taskId };
      span.setAttribute("task_id", identity.taskId);
      span.setAttribute("session_id", identity.sessionId);
      if (task.source) span.setAttribute("intake_source", task.source);
      const flow = buildPipelineFlow({
        ...identity,
        title: task.title,
        description: task.description,
        repoId: task.repoId,
        source: task.source,
        linearIssueId: task.linearIssueId,
      });
      await enqueuer.add(flow);
      return { ...identity, flow };
    },
  );
}
