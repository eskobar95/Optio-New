/**
 * Optional Redis / Postgres proof. Skipped unless the env URL is set, so CI stays green.
 */
import { resolveTenantContext } from "../src/config/tenant.js";
import { closeSharedPool, getSharedPool } from "../src/db/pool.js";
import { FlowProducer } from "bullmq";
import { describe, expect, it } from "vitest";
import {
  buildPipelineFlow,
  bullmqStageWorkerFactory,
  createPgStepCursorStore,
  InMemoryStepCursorStore,
  processStageJob,
  startStageGraph,
  type StageStepHandler,
} from "../src/index.js";

const redisUrl = process.env.OPTIO_NEW_REDIS_URL;
const databaseUrl = process.env.OPTIO_NEW_DATABASE_URL;

function recording(calls: string[]): StageStepHandler {
  return {
    async run(ctx) {
      calls.push(`${ctx.stage}:${ctx.step}`);
    },
  };
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out waiting for pipeline cursor");
}

describe.skipIf(!redisUrl)("BullMQ Redis flow", () => {
  it("processes plan before merge when OPTIO_NEW_REDIS_URL is set", async () => {
    if (!redisUrl) {
      return;
    }
    const taskId = `redis-${Date.now()}`;
    const sessionId = `session-${Date.now()}`;
    const calls: string[] = [];
    const cursors = new InMemoryStepCursorStore();
    const connection = { url: redisUrl, maxRetriesPerRequest: null };
    const workers = startStageGraph(
      { cursors, handler: recording(calls) },
      bullmqStageWorkerFactory(connection),
    );
    const producer = new FlowProducer({ connection });
    try {
      await producer.add(buildPipelineFlow({ taskId, sessionId }));
      await waitFor(async () => {
        const merge = await cursors.get(taskId, sessionId, "merge");
        return merge?.status === "completed";
      }, 20_000);
      expect(calls[0]).toBe("plan:ack_session");
      expect(calls.at(-1)).toBe("merge:record_cleanup");
      expect(calls).toHaveLength(10);
    } finally {
      await producer.close();
      await Promise.all(workers.map((worker) => worker.close()));
    }
  }, 30_000);
});

describe.skipIf(!databaseUrl)("Postgres step cursor integration", () => {
  it("resumes a crashed plan stage when OPTIO_NEW_DATABASE_URL is set", async () => {
    if (!databaseUrl) {
      return;
    }
    const store = await createPgStepCursorStore(
      getSharedPool(databaseUrl),
      resolveTenantContext({}),
    );
    const taskId = `pg-${Date.now()}`;
    const sessionId = `session-${Date.now()}`;
    const calls: string[] = [];
    let crash = true;
    const handler: StageStepHandler = {
      async run(ctx) {
        const key = `${ctx.stage}:${ctx.step}`;
        if (crash && key === "plan:invoke_planner") {
          crash = false;
          throw new Error("worker crashed");
        }
        calls.push(key);
      },
    };
    try {
      await expect(
        processStageJob({ taskId, sessionId, stage: "plan" }, { cursors: store, handler }),
      ).rejects.toThrow(/worker crashed/);
      calls.length = 0;
      const resumed = await processStageJob(
        { taskId, sessionId, stage: "plan" },
        { cursors: store, handler },
      );
      expect(calls).toEqual(["plan:invoke_planner"]);
      expect(resumed.status).toBe("completed");
    } finally {
      await getSharedPool(databaseUrl).query(
        "DELETE FROM pipeline_step_cursor WHERE task_id = $1",
        [taskId],
      );
      await closeSharedPool();
    }
  }, 30_000);
});
