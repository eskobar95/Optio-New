/**
 * BullMQ consumer for `optio.learn`. Tests inject the worker factory and never open Redis.
 */
import { Worker, type ConnectionOptions } from "bullmq";
import type { LearningObservationInput, LearningSink } from "./observation.js";
import { processLearningObservation, type LearningProcessorDeps } from "./process.js";

export const LEARNING_QUEUE = "optio.learn";

export interface LearningWorkerHandle {
  close(): Promise<void>;
}

export interface LearningWorkerFactory {
  create(queueName: string, processor: (data: unknown) => Promise<unknown>): LearningWorkerHandle;
}

export function createQueueLearningSink(queue: {
  add(name: string, data: unknown): Promise<unknown>;
}): LearningSink {
  return {
    async record(observation: LearningObservationInput) {
      await queue.add("fingerprint", observation);
    },
  };
}

export function startLearningWorker(
  deps: LearningProcessorDeps,
  factory: LearningWorkerFactory,
): LearningWorkerHandle {
  return factory.create(LEARNING_QUEUE, (data) => processLearningObservation(data, deps));
}

export function bullmqLearningWorkerFactory(connection: ConnectionOptions): LearningWorkerFactory {
  return {
    create(queueName, processor) {
      const worker = new Worker(queueName, async (job) => processor(job.data), { connection });
      return {
        async close() {
          await worker.close();
        },
      };
    },
  };
}
