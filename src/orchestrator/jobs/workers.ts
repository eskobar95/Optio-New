/**
 * One BullMQ worker per stage queue. The processor is injected so unit tests never open Redis.
 */
import { Worker, type ConnectionOptions } from "bullmq";
import { PIPELINE_STAGES, STAGE_QUEUES, StageJobPayloadSchema } from "./stages.js";
import { processStageJob, type StageRuntime } from "./run-stage.js";

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

export function bullmqStageWorkerFactory(connection: ConnectionOptions): StageWorkerFactory {
  return {
    create(queueName, processor) {
      const worker = new Worker(queueName, async (job) => processor(job.data), { connection });
      worker.on("error", (error: Error) => {
        console.error(
          JSON.stringify({ msg: "worker error", queue: queueName, error: error.message }),
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
