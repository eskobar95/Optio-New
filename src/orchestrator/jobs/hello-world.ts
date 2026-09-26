/**
 * Hello-world path: intake enqueue, then the plan stage cursor reaches completed.
 * GET /hello is the demo card. GET /hello/plan reads the cursor. Live Compose
 * proof is scripts/hello-world-e2e.sh. runHelloWorldPlan is the in-process proof.
 */
import type { FlowJob } from "bullmq";
import { enqueueIntakePipeline } from "./enqueue-pipeline.js";
import { InMemoryStepCursorStore, type StepCursorStatus, type StepCursorStore } from "./cursor.js";
import { processStageJob } from "./run-stage.js";
import { STAGE_QUEUES } from "./stages.js";

export const HELLO_WORLD_RESPONSE = {
  ok: true as const,
  hello: "world" as const,
  stage: "plan" as const,
  queue: STAGE_QUEUES.plan,
  intake: "/intake",
  progress: "/hello/plan",
};

export type HelloWorldResponse = typeof HELLO_WORLD_RESPONSE;

export type PlanStageStatus = StepCursorStatus | "queued";

export interface PlanStageView {
  ok: true;
  hello: "world";
  taskId: string;
  sessionId: string;
  stage: "plan";
  queue: typeof STAGE_QUEUES.plan;
  status: PlanStageStatus;
  nextStepIndex: number;
  /** True only after the plan stage cursor is completed. */
  progressed: boolean;
}

export interface HelloWorldPlanProof {
  taskId: string;
  sessionId: string;
  jobId: string;
  queue: typeof STAGE_QUEUES.plan;
  steps: string[];
  plan: PlanStageView;
}

export async function processHelloWorld(taskId: string): Promise<{ ok: true; taskId: string }> {
  console.log(`[optio-new] hello-world ack taskId=${taskId}`);
  return { ok: true, taskId };
}

export async function readPlanStage(
  cursors: Pick<StepCursorStore, "get">,
  taskId: string,
  sessionId: string,
): Promise<PlanStageView> {
  const cursor = await cursors.get(taskId, sessionId, "plan");
  const status: PlanStageStatus = cursor?.status ?? "queued";
  return {
    ok: true,
    hello: "world",
    taskId,
    sessionId,
    stage: "plan",
    queue: STAGE_QUEUES.plan,
    status,
    nextStepIndex: cursor?.nextStepIndex ?? 0,
    progressed: status === "completed",
  };
}

function planLeaf(flow: FlowJob): FlowJob {
  let current = flow;
  while (current.children?.[0]) {
    current = current.children[0] as FlowJob;
  }
  return current;
}

/**
 * Enqueue the intake flow and run only the plan stage. Later stages stay unstarted.
 */
export async function runHelloWorldPlan(
  input: { taskId: string; title: string; description?: string; sessionId?: string },
  cursors: StepCursorStore = new InMemoryStepCursorStore(),
): Promise<HelloWorldPlanProof> {
  const steps: string[] = [];
  let flow: FlowJob | undefined;
  const enqueued = await enqueueIntakePipeline(
    {
      taskId: input.taskId,
      title: input.title,
      description: input.description ?? "",
    },
    {
      async add(job) {
        flow = job;
      },
    },
    input.sessionId,
  );
  if (!flow) {
    throw new Error("intake did not enqueue a flow");
  }
  const plan = planLeaf(flow);
  if (plan.queueName !== STAGE_QUEUES.plan) {
    throw new Error("intake flow leaf is not the plan stage");
  }
  await processStageJob(plan.data, {
    cursors,
    handler: {
      async run(ctx) {
        if (ctx.stage === "plan" && ctx.step === "ack_session") {
          await processHelloWorld(ctx.taskId);
        }
        steps.push(`${ctx.stage}:${ctx.step}`);
      },
    },
  });
  const view = await readPlanStage(cursors, enqueued.taskId, enqueued.sessionId);
  return {
    taskId: enqueued.taskId,
    sessionId: enqueued.sessionId,
    jobId: `${enqueued.sessionId}__plan`,
    queue: STAGE_QUEUES.plan,
    steps,
    plan: view,
  };
}
