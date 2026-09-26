/**
 * One BullMQ worker per stage queue. The processor is injected so unit tests never open Redis.
 */
import { DelayedError, Worker, type ConnectionOptions } from "bullmq";
import { ApprovalRequiredError } from "./hitl.js";
import { PIPELINE_STAGES, STAGE_QUEUES, StageJobPayloadSchema } from "./stages.js";
import { processStageJob, type StageRuntime } from "./run-stage.js";
import { logStageEvent } from "./stage-log.js";

export interface StageWorkerHandle {
  close(): Promise<void>;
}

export interface StageWorkerFactory {
  create(queueName: string, processor: (data: unknown) => Promise<unknown>): StageWorkerHandle;
}

export function startStageGraph(
  deps: StageRuntime,
  factory: StageWorkerFactory,
): StageWorkerHandle[] {
  return PIPELINE_STAGES.map((stage) => {
    const queueName = STAGE_QUEUES[stage];
    return factory.create(queueName, async (data) => {
      const payload = StageJobPayloadSchema.parse(data);
      if (payload.stage !== stage) {
        throw new Error(`queue ${queueName} received stage ${payload.stage}`);
      }
      return processStageJob(payload, deps);
    });
  });
}

export interface BullmqStageWorkerOptions {
  /** How long a required approval waits before the worker checks again. */
  hitlPollMs?: number;
}

/**
 * A required approval delays the BullMQ job. It does not complete the stage and does not approve it.
 * The next delivery runs the gate again.
 */
export async function delayJobForApproval(
  error: unknown,
  job: { moveToDelayed(when: number, token?: string): Promise<void> },
  token: string | undefined,
  pollMs: number,
): Promise<boolean> {
  if (!(error instanceof ApprovalRequiredError)) return false;
  const wait = pollMs > 0 ? pollMs : 60_000;
  await job.moveToDelayed(Date.now() + wait, token);
  return true;
}

export function bullmqStageWorkerFactory(
  connection: ConnectionOptions,
  options?: BullmqStageWorkerOptions,
): StageWorkerFactory {
  const pollMs = options?.hitlPollMs ?? 60_000;
  return {
    create(queueName, processor) {
      const worker = new Worker(
        queueName,
        async (job, token) => {
          try {
            return await processor(job.data);
          } catch (error) {
            if (await delayJobForApproval(error, job, token, pollMs)) {
              throw new DelayedError();
            }
            throw error;
          }
        },
        { connection },
      );
      worker.on("error", (error: Error) => {
        logStageEvent(
          { msg: "worker error", queue: queueName, error: error.message },
          console.error,
        );
      });
      return {
        async close() {
          await worker.close();
        },
      };
    },
  };
}
