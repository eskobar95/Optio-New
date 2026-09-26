/**
 * Orchestrator process: POST /intake plus one BullMQ worker per stage queue.
 * Postgres (OPTIO_NEW_DATABASE_URL) stores the step cursor. Redis is the queue.
 * Stage steps are acked here. createEnvModelAdapter does not perform HTTP yet,
 * so this process does not call it. Eve agents stay contracts without a process.
 */
import { FlowProducer } from "bullmq";
import { Redis } from "ioredis";
import { createIntakeServer } from "./intake/http.js";
import { createPgStepCursorStore } from "./jobs/cursor.js";
import type { StageStepContext } from "./jobs/run-stage.js";
import { bullmqStageWorkerFactory, startStageGraph } from "./jobs/workers.js";
import { readOrchestratorPort, redisConnectionOptions } from "./redis.js";

export async function startOrchestrator(): Promise<void> {
  const port = readOrchestratorPort(process.env.ORCHESTRATOR_PORT);
  const redisUrl = process.env.OPTIO_NEW_REDIS_URL ?? "redis://127.0.0.1:6379";
  const databaseUrl = process.env.OPTIO_NEW_DATABASE_URL?.trim() ?? "";
  if (!databaseUrl) {
    throw new Error("OPTIO_NEW_DATABASE_URL is required");
  }

  const connection = redisConnectionOptions(redisUrl);
  const cursors = await createPgStepCursorStore(databaseUrl);
  const workers = startStageGraph(
    {
      cursors,
      handler: {
        async run(ctx: StageStepContext) {
          console.log(
            JSON.stringify({
              msg: "stage step",
              taskId: ctx.taskId,
              sessionId: ctx.sessionId,
              stage: ctx.stage,
              step: ctx.step,
            }),
          );
        },
      },
    },
    bullmqStageWorkerFactory(connection),
  );

  const flow = new FlowProducer({ connection });
  flow.on("error", (error: Error) => {
    console.error(JSON.stringify({ msg: "flow error", error: error.message }));
  });

  const redis = new Redis(redisUrl, {
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    enableOfflineQueue: false,
  });
  redis.on("error", (error: Error) => {
    console.error(JSON.stringify({ msg: "redis health error", error: error.message }));
  });

  const server = createIntakeServer({
    enqueuer: {
      add: (job) => flow.add(job),
    },
    checkRedis: async () => {
      try {
        return (await redis.ping()) === "PONG";
      } catch {
        return false;
      }
    },
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => resolve());
  });

  console.log(JSON.stringify({ msg: "orchestrator listening", port }));

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(JSON.stringify({ msg: "orchestrator stopping", signal }));
    server.close();
    await Promise.all(workers.map((worker) => worker.close()));
    await flow.close();
    await cursors.close();
    redis.disconnect();
    process.exit(0);
  };

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
}

startOrchestrator().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      msg: "orchestrator failed to start",
      error: error instanceof Error ? error.message : "unknown",
    }),
  );
  process.exit(1);
});
