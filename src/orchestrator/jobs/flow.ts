/**
 * BullMQ flow: children run before parents, so plan is the leaf and merge is the root.
 * Each parent waits until its child stage job completes.
 */
import type { FlowChildJob, FlowJob } from "bullmq";
import {
  PIPELINE_JOB_ATTEMPTS,
  PIPELINE_STAGES,
  PipelineIdentitySchema,
  STAGE_QUEUES,
  type PipelineIdentity,
  type PipelineStage,
} from "./stages.js";

function stageNode(
  stage: PipelineStage,
  identity: PipelineIdentity,
  child?: FlowChildJob,
): FlowChildJob {
  const node: FlowChildJob = {
    name: stage,
    queueName: STAGE_QUEUES[stage],
    data: { taskId: identity.taskId, sessionId: identity.sessionId, stage },
    opts: {
      jobId: `${identity.sessionId}__${stage}`,
      attempts: PIPELINE_JOB_ATTEMPTS,
      backoff: { type: "exponential", delay: 1000 },
    },
  };
  if (child) {
    node.children = [child];
  }
  return node;
}

export function buildPipelineFlow(input: { taskId: string; sessionId: string }): FlowJob {
  const identity = PipelineIdentitySchema.parse(input);
  let node: FlowChildJob | undefined;
  for (const stage of PIPELINE_STAGES) {
    node = stageNode(stage, identity, node);
  }
  if (!node) {
    throw new Error("pipeline has no stages");
  }
  return node;
}
