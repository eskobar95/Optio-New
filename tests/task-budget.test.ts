import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  BudgetExceededError,
  InMemoryStepCursorStore,
  InMemoryUsageStore,
  createIntakeServer,
  createSqlUsageStore,
  loadTaskBudgetCaps,
  loadTaskUsageDdl,
  processStageJob,
  readTaskBudgetStatus,
  type SqlExecutor,
  type StageStepHandler,
  type StageStepUsage,
} from "../src/index.js";

const identity = { taskId: "t-1", sessionId: "s-1" };
const small: StageStepUsage = { inputTokens: 10, outputTokens: 5, costUsd: 0.01 };

function spend(calls: string[], usage?: StageStepUsage | "omit"): StageStepHandler {
  return {
    async run(ctx) {
      calls.push(`${ctx.stage}:${ctx.step}`);
      if (!ctx.step.startsWith("invoke_")) return undefined;
      if (usage === "omit") return {};
      return { usage: usage ?? small };
    },
  };
}

function budgetFor(caps = loadTaskBudgetCaps({}), logs?: string[]) {
  return {
    caps,
    usage: new InMemoryUsageStore(),
    log(line: string) {
      logs?.push(line);
    },
  };
}

describe("task budget caps", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((err) => (err ? reject(err) : resolve()));
          }),
      ),
    );
  });

  it("lets a reported run under the cap continue and shows the caps in status", async () => {
    const calls: string[] = [];
    const logs: string[] = [];
    const budget = budgetFor(loadTaskBudgetCaps({}), logs);
    const cursors = new InMemoryStepCursorStore();
    const result = await processStageJob(
      { ...identity, stage: "plan" },
      { cursors, handler: spend(calls), budget },
    );
    expect(result.status).toBe("completed");
    expect(calls).toEqual(["plan:ack_session", "plan:invoke_planner"]);
    const status = await readTaskBudgetStatus(budget, identity);
    expect(status.caps).toMatchObject({ maxTokens: 200_000, maxUsd: 2 });
    expect(status.usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      tokens: 15,
      costUsd: 0.01,
    });
    expect(status.exceeded).toBe(false);
    const line = [...logs].reverse().find((entry) => entry.includes("invoke_planner"));
    expect(line).toBeDefined();
    const parsed = JSON.parse(line ?? "{}") as Record<string, unknown>;
    expect(parsed).toMatchObject({ msg: "task_budget", maxTokens: 200_000, maxUsd: 2, tokens: 15 });
    expect(JSON.stringify(parsed)).not.toMatch(/api[_-]?key|secret|authorization|bearer|sk-|ghp_/i);
  });

  it("does not call the handler when the ledger is already over the cap", async () => {
    const calls: string[] = [];
    const budget = budgetFor(
      loadTaskBudgetCaps({ OPTIO_TASK_MAX_TOKENS: "20", OPTIO_TASK_MAX_USD: "1" }),
    );
    await budget.usage.add(
      "t-1",
      "s-1",
      "plan",
      { inputTokens: 15, outputTokens: 10, costUsd: 0.1 },
      "t",
    );
    const cursors = new InMemoryStepCursorStore();
    await expect(
      processStageJob({ ...identity, stage: "plan" }, { cursors, handler: spend(calls), budget }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    expect(calls).toEqual(["plan:ack_session"]);
    const plan = await cursors.get("t-1", "s-1", "plan");
    expect(plan?.status).not.toBe("completed");
  });

  it("fails closed after an agent run that exceeds the cap and does not start the next stage", async () => {
    const calls: string[] = [];
    const budget = budgetFor(
      loadTaskBudgetCaps({ OPTIO_TASK_MAX_TOKENS: "100", OPTIO_TASK_MAX_USD: "1" }),
    );
    const cursors = new InMemoryStepCursorStore();
    const deps = {
      cursors,
      budget,
      handler: spend(calls, { inputTokens: 80, outputTokens: 40, costUsd: 0.2 }),
    };
    await expect(processStageJob({ ...identity, stage: "plan" }, deps)).rejects.toMatchObject({
      code: "BudgetExceeded",
      reason: "token_cap",
    });
    expect(calls).toEqual(["plan:ack_session", "plan:invoke_planner"]);
    await expect(processStageJob({ ...identity, stage: "implement" }, deps)).rejects.toThrow(
      /waits on plan/,
    );
    expect(calls).not.toContain("implement:invoke_implementation");
  });

  it("fails closed when an agent run does not report usage", async () => {
    const calls: string[] = [];
    const budget = budgetFor();
    const cursors = new InMemoryStepCursorStore();
    await expect(
      processStageJob(
        { ...identity, stage: "plan" },
        { cursors, handler: spend(calls, "omit"), budget },
      ),
    ).rejects.toMatchObject({ code: "BudgetExceeded", reason: "usage_unreported" });
    expect(calls).toContain("plan:invoke_planner");
    expect((await cursors.get("t-1", "s-1", "plan"))?.status).not.toBe("completed");
  });

  it("enforces a per-stage cap inside the task cap", async () => {
    const yaml = readFileSync("workflows/default-task.yaml", "utf8");
    const caps = loadTaskBudgetCaps(
      { OPTIO_TASK_MAX_TOKENS: "500000", OPTIO_TASK_MAX_USD: "20" },
      yaml,
    );
    expect(caps.stages?.implement).toEqual({ maxTokens: 120_000, maxUsd: 1.2 });
    const calls: string[] = [];
    const budget = budgetFor(caps);
    const cursors = new InMemoryStepCursorStore();
    const deps = {
      cursors,
      budget,
      handler: spend(calls, { inputTokens: 1, outputTokens: 1, costUsd: 0.01 }),
    };
    await processStageJob({ ...identity, stage: "plan" }, deps);
    deps.handler = spend(calls, { inputTokens: 100_000, outputTokens: 30_000, costUsd: 0.5 });
    await expect(processStageJob({ ...identity, stage: "implement" }, deps)).rejects.toMatchObject({
      reason: "stage_token_cap",
    });
  });

  it("lets env override the workflow totals and rejects a bad number", () => {
    const yaml = readFileSync("workflows/default-task.yaml", "utf8");
    expect(loadTaskBudgetCaps({}, yaml)).toMatchObject({ maxTokens: 200_000, maxUsd: 2 });
    expect(
      loadTaskBudgetCaps({ OPTIO_TASK_MAX_TOKENS: "50", OPTIO_TASK_MAX_USD: "0.25" }, yaml),
    ).toMatchObject({
      maxTokens: 50,
      maxUsd: 0.25,
    });
    expect(() => loadTaskBudgetCaps({ OPTIO_TASK_MAX_USD: "nope" })).toThrow(/OPTIO_TASK_MAX_USD/);
    const ddl = loadTaskUsageDdl();
    expect(ddl).toContain("CREATE TABLE IF NOT EXISTS task_usage");
    expect(ddl).toContain("PRIMARY KEY (task_id, session_id, stage)");
  });

  it("adds usage through the SQL store and serves GET /budget", async () => {
    const rows = new Map<string, Record<string, unknown>>();
    const db: SqlExecutor = {
      async query(sql, params = []) {
        if (sql.startsWith("INSERT")) {
          const [taskId, sessionId, stage, inputTokens, outputTokens, costUsd] = params;
          const key = `${String(taskId)}|${String(sessionId)}|${String(stage)}`;
          const prior = rows.get(key);
          rows.set(key, {
            stage,
            input_tokens: Number(prior?.input_tokens ?? 0) + Number(inputTokens),
            output_tokens: Number(prior?.output_tokens ?? 0) + Number(outputTokens),
            cost_usd: Number(prior?.cost_usd ?? 0) + Number(costUsd),
          });
          return { rows: [] };
        }
        if (sql.startsWith("SELECT")) {
          const [taskId, sessionId] = params;
          const prefix = `${String(taskId)}|${String(sessionId)}|`;
          return {
            rows: [...rows.entries()]
              .filter(([key]) => key.startsWith(prefix))
              .map(([, row]) => row),
          };
        }
        throw new Error(`unexpected sql: ${sql}`);
      },
    };
    const usage = createSqlUsageStore(db);
    await usage.add("t-1", "s-1", "plan", { inputTokens: 4, outputTokens: 6, costUsd: 0.02 }, "t");
    const snapshot = await usage.get("t-1", "s-1");
    expect(snapshot.task).toEqual({ inputTokens: 4, outputTokens: 6, costUsd: 0.02 });

    const budget = { caps: loadTaskBudgetCaps({}), usage };
    const server = createIntakeServer({
      enqueuer: { async add() {} },
      budgetStatus: (taskId, sessionId) => readTaskBudgetStatus(budget, { taskId, sessionId }),
    });
    servers.push(server);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/budget?taskId=t-1&sessionId=s-1`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { usage: { tokens: number }; caps: { maxUsd: number } };
    expect(body.usage.tokens).toBe(10);
    expect(body.caps.maxUsd).toBe(2);
    expect(JSON.stringify(body)).not.toMatch(/api[_-]?key|secret|authorization|bearer/i);
  });
});
