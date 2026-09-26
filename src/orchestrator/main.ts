/**
 * Orchestrator process: POST /intake, GET /hello, and one BullMQ worker per stage queue.
 * Postgres (OPTIO_NEW_DATABASE_URL) stores the step cursor. Redis is the queue.
 * Stage steps run createProductionStageHandler (Cursor coding agent, worktrees, GitHub PRs).
 * createEnvModelAdapter performs no HTTP. Planner steps require CURSOR_API_KEY, or they
 * fail with StageCredentialsError when MODEL_API_KEY / MODEL_ENDPOINT are missing or unused.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { FlowProducer, Queue } from "bullmq";
import { Redis } from "ioredis";
import { readPlanStage } from "./jobs/hello-world.js";
import { createIntakeServer } from "./intake/http.js";
import { dumpSessionArtifactTrail, readArtifactLimits } from "./artifacts/index.js";
import { loadTaskBudgetCaps, createPgUsageStore, readTaskBudgetStatus } from "./jobs/budget.js";
import { applyHitlDecision, createHitlQueuePort, loadHitlConfig } from "./jobs/hitl.js";
import { createPgHitlStore } from "./jobs/hitl-store.js";
import { openOrchestratorDatabase } from "./jobs/pg-state.js";
import { createProductionStageHandler } from "./jobs/production-handler.js";
import { STAGE_QUEUES } from "./jobs/stages.js";
import { createPgStageRunStore, createStageRunLog } from "./observability/run-log.js";
import { bullmqStageWorkerFactory, startStageGraph } from "./jobs/workers.js";
import { logStageEvent } from "./jobs/stage-log.js";
import { loadRepoCatalog, readWorkflowRepoId } from "./repos/catalog.js";
import { createGuardedRepoWorktrees } from "./repos/router.js";
import { readOrchestratorPort, redisConnectionOptions } from "./redis.js";
import { getStageTracer } from "./telemetry/index.js";
import { loadWorktreeRuntimeConfig } from "./worktrees/config.js";

async function readWorkflowYaml(): Promise<string | undefined> {
  const candidates = [
    path.join(process.cwd(), "workflows", "default-task.yaml"),
    process.env.OPTIO_NEW_REPO_PATH
      ? path.join(process.env.OPTIO_NEW_REPO_PATH, "workflows", "default-task.yaml")
      : "",
  ].filter((candidate) => candidate.length > 0);
  for (const candidate of candidates) {
    try {
      return await readFile(candidate, "utf8");
    } catch {
      // The next candidate, or the built-in defaults, still load the gates.
    }
  }
  return undefined;
}

export async function startOrchestrator(): Promise<void> {
  const port = readOrchestratorPort(process.env.ORCHESTRATOR_PORT);
  const redisUrl = process.env.OPTIO_NEW_REDIS_URL ?? "redis://127.0.0.1:6379";
  const databaseUrl = process.env.OPTIO_NEW_DATABASE_URL?.trim() ?? "";
  if (!databaseUrl) {
    throw new Error("OPTIO_NEW_DATABASE_URL is required");
  }

  const connection = redisConnectionOptions(redisUrl);
  const database = await openOrchestratorDatabase(databaseUrl);
  const cursors = database.cursors;
  const stageRuns = await createPgStageRunStore(databaseUrl);
  const runLog = createStageRunLog(stageRuns);
  const repoCatalog = loadRepoCatalog(process.env);
  const worktreeConfig = loadWorktreeRuntimeConfig(process.env);
  const worktrees = createGuardedRepoWorktrees(process.env, {
    catalog: repoCatalog,
    tracer: getStageTracer(),
  });
  const workflowYaml = await readWorkflowYaml();
  const workflowRepoId = workflowYaml === undefined ? undefined : readWorkflowRepoId(workflowYaml);
  const hitlConfig = loadHitlConfig(process.env, workflowYaml);
  const caps = loadTaskBudgetCaps(process.env, workflowYaml);
  const hitlState = await createPgHitlStore(databaseUrl);
  const usage = await createPgUsageStore(databaseUrl);
  const planQueue = new Queue(STAGE_QUEUES.plan, { connection });
  const implementQueue = new Queue(STAGE_QUEUES.implement, { connection });
  const readyQueue = new Queue(STAGE_QUEUES.ready, { connection });
  const hitl = {
    config: hitlConfig,
    store: hitlState,
    signals: hitlState,
    queue: createHitlQueuePort({
      plan: planQueue,
      implement: implementQueue,
      ready: readyQueue,
    }),
  };
  const budget = { caps, usage };
  logStageEvent({
    msg: "orchestrator gates",
    hitlPlan: hitlConfig.plan.mode,
    hitlMerge: hitlConfig.merge.mode,
    hitlTimeoutMs: hitlConfig.timeoutMs,
    maxTokens: caps.maxTokens,
    maxUsd: caps.maxUsd,
  });
  logStageEvent({
    msg: "orchestrator stage handler",
    cursorApiKey: Boolean(process.env.CURSOR_API_KEY?.trim()),
    githubToken: Boolean(process.env.OPTIO_NEW_GITHUB_TOKEN?.trim()),
    githubRepo: Boolean(process.env.OPTIO_NEW_GITHUB_REPO?.trim()),
    linearWebhook: Boolean(process.env.OPTIO_NEW_LINEAR_WEBHOOK_SECRET?.trim()),
    linearApiKey: Boolean(process.env.OPTIO_NEW_LINEAR_API_KEY?.trim()),
    linearDefaultRepoId: process.env.OPTIO_NEW_LINEAR_DEFAULT_REPO_ID?.trim() || "",
    modelApiKey: Boolean(process.env.MODEL_API_KEY?.trim()),
    modelEndpoint: Boolean(process.env.MODEL_ENDPOINT?.trim()),
    worktreeRoot: worktreeConfig.root,
    retainOnFailure: worktreeConfig.retainOnFailure,
    repos: repoCatalog.repos.map((repo) => repo.repoId),
    defaultRepoId: repoCatalog.defaultRepoId,
  });
  const workers = startStageGraph(
    {
      cursors,
      worktrees,
      artifacts: database.artifacts,
      artifactLimits: readArtifactLimits(process.env),
      handler: createProductionStageHandler({
        env: process.env,
        worktrees,
        catalog: repoCatalog,
      }),
      runLog,
      hitl,
      budget,
    },
    bullmqStageWorkerFactory(connection, { hitlPollMs: hitlConfig.pollMs }),
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
    approvals: {
      list: (taskId, sessionId) => hitlState.list(taskId, sessionId),
      decide: (input) => applyHitlDecision(input, hitl, cursors),
    },
    budgetStatus: (taskId, sessionId) => readTaskBudgetStatus(budget, { taskId, sessionId }),
    readArtifactTrail: (taskId, sessionId) =>
      dumpSessionArtifactTrail(database.artifacts, taskId, sessionId),
    webhookSecret: process.env.OPTIO_NEW_INTAKE_WEBHOOK_SECRET,
    repoCatalog,
    workflowRepoId,
    githubWebhookSecret: process.env.OPTIO_NEW_GITHUB_WEBHOOK_SECRET,
    slackSigningSecret: process.env.OPTIO_NEW_SLACK_SIGNING_SECRET,
    linearWebhookSecret: process.env.OPTIO_NEW_LINEAR_WEBHOOK_SECRET,
    linearApiKey: process.env.OPTIO_NEW_LINEAR_API_KEY,
    linearDefaultRepoId: process.env.OPTIO_NEW_LINEAR_DEFAULT_REPO_ID,
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
    await Promise.all([planQueue.close(), implementQueue.close(), readyQueue.close()]);
    await database.close();
    await stageRuns.close();
    await hitlState.close();
    await usage.close();
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
