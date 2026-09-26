/**
 * New Bot intake → BullMQ flow. Validation stays in buildIntakeJob; this only enqueues.
 */
import type { FlowJob } from "bullmq";
import { buildIntakeJob } from "../intake/enqueue.js";
import { buildPipelineFlow } from "./flow.js";

export interface FlowEnqueuer {
  add(flow: FlowJob): Promise<unknown>;
}

export async function enqueueIntakePipeline(
  input: unknown,
  enqueuer: FlowEnqueuer,
  sessionId?: string,
): Promise<{ taskId: string; sessionId: string; flow: FlowJob }> {
  const task = buildIntakeJob(input);
  const identity = { taskId: task.taskId, sessionId: sessionId ?? task.taskId };
  const flow = buildPipelineFlow(identity);
  await enqueuer.add(flow);
  return { ...identity, flow };
}
