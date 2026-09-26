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
  brief: {
    title?: string;
    description?: string;
    repoId?: string;
    source?: "http" | "github" | "slack" | "linear";
    linearIssueId?: string;
  },
  child?: FlowChildJob,
): FlowChildJob {
  const data: {
    taskId: string;
    sessionId: string;
    stage: PipelineStage;
    title?: string;
    description?: string;
    repoId?: string;
    source?: "http" | "github" | "slack" | "linear";
    linearIssueId?: string;
  } = { taskId: identity.taskId, sessionId: identity.sessionId, stage };
  if (brief.title) data.title = brief.title;
  if (brief.description) data.description = brief.description;
  if (brief.repoId) data.repoId = brief.repoId;
  if (brief.source) data.source = brief.source;
  if (brief.linearIssueId) data.linearIssueId = brief.linearIssueId;
  const node: FlowChildJob = {
    name: stage,
    queueName: STAGE_QUEUES[stage],
    data,
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

export function buildPipelineFlow(input: {
  taskId: string;
  sessionId: string;
  title?: string;
  description?: string;
  repoId?: string;
  source?: "http" | "github" | "slack" | "linear";
  linearIssueId?: string;
}): FlowJob {
  const identity = PipelineIdentitySchema.parse(input);
  const brief = {
    title: input.title?.trim() || undefined,
    description: input.description?.trim() || undefined,
    repoId: input.repoId?.trim() || undefined,
    source: input.source,
    linearIssueId: input.linearIssueId?.trim() || undefined,
  };
  let node: FlowChildJob | undefined;
  for (const stage of PIPELINE_STAGES) {
    node = stageNode(stage, identity, brief, node);
  }
  if (!node) {
    throw new Error("pipeline has no stages");
  }
  return node;
}
