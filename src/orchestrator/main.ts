/**
 * Orchestrator process: POST /intake, GET /hello, and one BullMQ worker per stage queue.
 * Postgres (OPTIO_NEW_DATABASE_URL) stores the step cursor. Redis is the queue.
 * Stage steps run createProductionStageHandler (Cursor coding agent, worktrees, GitHub PRs).
 * createEnvModelAdapter performs no HTTP. Planner steps require CURSOR_API_KEY, or they
 * fail with StageCredentialsError when MODEL_API_KEY / MODEL_ENDPOINT are missing or unused.
 */
import { FlowProducer } from "bullmq";
import { Redis } from "ioredis";
import { readPlanStage } from "./jobs/hello-world.js";
import { createIntakeServer } from "./intake/http.js";
import { createPgStepCursorStore } from "./jobs/cursor.js";
import { createProductionStageHandler } from "./jobs/production-handler.js";
import { createPgStageRunStore, createStageRunLog } from "./observability/run-log.js";
import { bullmqStageWorkerFactory, startStageGraph } from "./jobs/workers.js";
import { logStageEvent } from "./jobs/stage-log.js";
import { readOrchestratorPort, redisConnectionOptions } from "./redis.js";
import { getStageTracer } from "./telemetry/index.js";
import { createWorktreeManagerFromEnv } from "./worktrees/config.js";

export async function startOrchestrator(): Promise<void> {
  const port = readOrchestratorPort(process.env.ORCHESTRATOR_PORT);
  const redisUrl = process.env.OPTIO_NEW_REDIS_URL ?? "redis://127.0.0.1:6379";
  const databaseUrl = process.env.OPTIO_NEW_DATABASE_URL?.trim() ?? "";
  if (!databaseUrl) {
    throw new Error("OPTIO_NEW_DATABASE_URL is required");
  }

  const connection = redisConnectionOptions(redisUrl);
  const cursors = await createPgStepCursorStore(databaseUrl);
  const stageRuns = await createPgStageRunStore(databaseUrl);
  const runLog = createStageRunLog(stageRuns);
  const worktrees = createWorktreeManagerFromEnv(process.env, getStageTracer());
  logStageEvent({
    msg: "orchestrator stage handler",
    cursorApiKey: Boolean(process.env.CURSOR_API_KEY?.trim()),
    githubToken: Boolean(process.env.OPTIO_NEW_GITHUB_TOKEN?.trim()),
    githubRepo: Boolean(process.env.OPTIO_NEW_GITHUB_REPO?.trim()),
    modelApiKey: Boolean(process.env.MODEL_API_KEY?.trim()),
    modelEndpoint: Boolean(process.env.MODEL_ENDPOINT?.trim()),
    worktreeRoot: process.env.OPTIO_NEW_WORKTREE_ROOT?.trim() || "/var/lib/optio-new/worktrees",
    retainOnFailure: process.env.OPTIO_NEW_WORKTREE_RETAIN_ON_FAILURE?.trim() !== "false",
  });
  const workers = startStageGraph(
    {
      cursors,
      worktrees,
      handler: createProductionStageHandler({ env: process.env, worktrees }),
      runLog,
    },
    bullmqStageWorkerFactory(connection),
  );

  const flow = new FlowProducer({ connection });
  flow.on("error", (error: Error) => {
    logStageEvent({ msg: "flow error", error: error.message }, console.error);
  });

  const redis = new Redis(redisUrl, {
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    enableOfflineQueue: false,
  });
  redis.on("error", (error: Error) => {
    logStageEvent({ msg: "redis health error", error: error.message }, console.error);
  });

  const server = createIntakeServer({
    enqueuer: {
      add: (job) => flow.add(job),
    },
    readPlanStage: (taskId, sessionId) => readPlanStage(cursors, taskId, sessionId),
    readTaskActions: (taskId) => runLog.inspect(taskId),
    webhookSecret: process.env.OPTIO_NEW_INTAKE_WEBHOOK_SECRET,
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

  logStageEvent({ msg: "orchestrator listening", port });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logStageEvent({ msg: "orchestrator stopping", signal });
    server.close();
    await Promise.all(workers.map((worker) => worker.close()));
    await flow.close();
    await cursors.close();
    await stageRuns.close();
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
  logStageEvent(
    {
      msg: "orchestrator failed to start",
      error: error instanceof Error ? error.message : "unknown",
    },
    console.error,
  );
  process.exit(1);
});
