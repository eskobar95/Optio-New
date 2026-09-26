import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { CodingAgent, CodingAgentInput } from "../src/adapters/coding-agent.js";
import {
  InMemoryStageRunStore,
  InMemoryStepCursorStore,
  createAgentStageHandler,
  createCursorAdapter,
  createIntakeServer,
  createProductionStageHandler,
  createSqlStageRunStore,
  createStageRunLog,
  createStageTracer,
  loadPipelineStageRunDdl,
  processStageJob,
  runAgentLoop,
  type ProductionWorktrees,
  type SqlExecutor,
  type StageStepHandler,
} from "../src/index.js";

const START = "2026-09-26T12:00:00.000Z";
const STEP_MS = 1000;

function tickingClock(start = START, stepMs = STEP_MS): () => Date {
  let ms = Date.parse(start);
  return () => {
    const value = new Date(ms);
    ms += stepMs;
    return value;
  };
}

function capture(method: "log" | "error"): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console[method];
  console[method] = (message?: unknown) => {
    lines.push(String(message));
  };
  return {
    lines,
    restore() {
      console[method] = original;
    },
  };
}

function jsonLines(lines: string[], msg: string): unknown[] {
  return lines
    .filter((line) => line.includes(`"msg":"${msg}"`))
    .map((line) => JSON.parse(line) as unknown);
}

function noopHandler(): StageStepHandler {
  return { async run() {} };
}

function crashHandler(stepName: string): StageStepHandler {
  return {
    async run(ctx) {
      if (ctx.step === stepName) throw new Error("worker crashed");
    },
  };
}

function memoryWorktrees(taskId: string): ProductionWorktrees {
  const handle = {
    taskId,
    worktreeId: `wt-${taskId}`,
    path: "/tmp/optio-run-log",
    branch: `task/${taskId}`,
  };
  let ready = false;
  return {
    async create() {
      ready = true;
      return handle;
    },
    async status() {
      return ready ? handle : undefined;
    },
    async reap(id, outcome) {
      return {
        taskId: id,
        action: "reaped",
        path: handle.path,
        reason: outcome.merged ? "merged" : "failure",
      };
    },
  };
}

function adapterInput(): CodingAgentInput {
  return {
    worktree_path: "/tmp/wt",
    prompt: "implement",
    allowed_tools: [],
    budget: {},
    metadata: {
      task_id: "t-span",
      worktree_id: "wt-span",
      workflow_id: "default-task",
      step_id: "implement",
      agent_id: "cursor",
    },
  };
}

describe("stage run log", () => {
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

  it("records start and end for each step a stage runs", async () => {
    const runLog = createStageRunLog(new InMemoryStageRunStore());
    const logs = capture("log");
    try {
      await processStageJob(
        { taskId: "t-1", sessionId: "s-1", stage: "plan" },
        {
          cursors: new InMemoryStepCursorStore(),
          handler: noopHandler(),
          runLog,
          now: tickingClock(),
        },
      );
    } finally {
      logs.restore();
    }

    expect(await runLog.inspect("t-1")).toEqual({
      taskId: "t-1",
      stages: [
        {
          sessionId: "s-1",
          stage: "plan",
          startedAt: "2026-09-26T12:00:00.000Z",
          endedAt: "2026-09-26T12:00:03.000Z",
          durationMs: 3000,
          status: "completed",
          usage: [],
          actions: [
            {
              at: "2026-09-26T12:00:01.000Z",
              sessionId: "s-1",
              stage: "plan",
              step: "ack_session",
              agentId: "agents/plan",
              name: "ack_session",
              status: "ok",
            },
            {
              at: "2026-09-26T12:00:02.000Z",
              sessionId: "s-1",
              stage: "plan",
              step: "invoke_planner",
              agentId: "agents/plan",
              name: "invoke_planner",
              status: "ok",
            },
          ],
        },
      ],
    });
    expect(jsonLines(logs.lines, "stage.completed")).toEqual([
      {
        msg: "stage.completed",
        taskId: "t-1",
        sessionId: "s-1",
        stage: "plan",
        startedAt: "2026-09-26T12:00:00.000Z",
        endedAt: "2026-09-26T12:00:03.000Z",
        durationMs: 3000,
      },
    ]);
  });

  it("logs the stage and reason when a stage fails, and keeps the first start across a retry", async () => {
    const runLog = createStageRunLog(new InMemoryStageRunStore());
    const cursors = new InMemoryStepCursorStore();
    const now = tickingClock();
    const errors = capture("error");
    const logs = capture("log");
    try {
      await expect(
        processStageJob(
          { taskId: "t-1", sessionId: "s-1", stage: "implement" },
          { cursors, handler: noopHandler(), runLog, now },
        ),
      ).rejects.toThrow("stage implement waits on plan");

      await expect(
        processStageJob(
          { taskId: "t-1", sessionId: "s-1", stage: "plan" },
          { cursors, handler: crashHandler("ack_session"), runLog, now },
        ),
      ).rejects.toThrow("worker crashed");

      await processStageJob(
        { taskId: "t-1", sessionId: "s-1", stage: "plan" },
        { cursors, handler: noopHandler(), runLog, now },
      );
    } finally {
      errors.restore();
      logs.restore();
    }

    expect(jsonLines(errors.lines, "stage.failed")).toEqual([
      {
        msg: "stage.failed",
        taskId: "t-1",
        sessionId: "s-1",
        stage: "implement",
        reason: "stage implement waits on plan",
        startedAt: "2026-09-26T12:00:00.000Z",
        endedAt: "2026-09-26T12:00:01.000Z",
        durationMs: 1000,
      },
      {
        msg: "stage.failed",
        taskId: "t-1",
        sessionId: "s-1",
        stage: "plan",
        step: "ack_session",
        reason: "worker crashed",
        startedAt: "2026-09-26T12:00:02.000Z",
        endedAt: "2026-09-26T12:00:03.000Z",
        durationMs: 1000,
      },
    ]);

    const view = await runLog.inspect("t-1");
    expect(view.stages.map((stage) => stage.stage)).toEqual(["plan", "implement"]);
    expect(view.stages[0]).toMatchObject({
      startedAt: "2026-09-26T12:00:02.000Z",
      endedAt: "2026-09-26T12:00:07.000Z",
      durationMs: 5000,
      status: "completed",
    });
    expect(view.stages[0]?.actions.map((action) => [action.step, action.status])).toEqual([
      ["ack_session", "error"],
      ["ack_session", "ok"],
      ["invoke_planner", "ok"],
    ]);
    expect(view.stages[1]).toMatchObject({
      status: "failed",
      reason: "stage implement waits on plan",
      startedAt: "2026-09-26T12:00:00.000Z",
      endedAt: "2026-09-26T12:00:01.000Z",
      durationMs: 1000,
    });
  });

  it("does not rewrite a completed stage when the job is delivered again", async () => {
    const runLog = createStageRunLog(new InMemoryStageRunStore());
    const cursors = new InMemoryStepCursorStore();
    const deps = {
      cursors,
      handler: noopHandler(),
      runLog,
      now: tickingClock(),
    };
    await processStageJob({ taskId: "t-1", sessionId: "s-1", stage: "plan" }, deps);
    const before = await runLog.inspect("t-1");
    await processStageJob({ taskId: "t-1", sessionId: "s-1", stage: "plan" }, deps);
    expect(await runLog.inspect("t-1")).toEqual(before);
  });

  it("attributes token and cost from a model adapter and ignores provider-only usage", async () => {
    const runLog = createStageRunLog(new InMemoryStageRunStore());
    const cursors = new InMemoryStepCursorStore();
    await processStageJob(
      { taskId: "t-1", sessionId: "s-1", stage: "plan" },
      {
        cursors,
        runLog,
        handler: createAgentStageHandler({
          async complete() {
            return {
              text: "planned",
              usage: {
                provider: "cursor",
                model_id: "composer",
                input_tokens: 120,
                output_tokens: 30,
                cost_usd: 0.02,
              },
            };
          },
        }),
      },
    );

    const bare = createStageRunLog(new InMemoryStageRunStore());
    await processStageJob(
      { taskId: "t-2", sessionId: "s-2", stage: "plan" },
      {
        cursors: new InMemoryStepCursorStore(),
        runLog: bare,
        handler: createAgentStageHandler({
          async complete() {
            return { text: "planned", usage: { provider: "cursor" } };
          },
        }),
      },
    );

    expect((await runLog.inspect("t-1")).stages[0]?.usage).toEqual([
      {
        agentId: "agents/plan",
        provider: "cursor",
        modelId: "composer",
        inputTokens: 120,
        outputTokens: 30,
        costUsd: 0.02,
      },
    ]);
    expect((await bare.inspect("t-2")).stages[0]?.usage).toEqual([]);
  });

  it("attributes coding-agent usage on the stage that ran the agent", async () => {
    const runLog = createStageRunLog(new InMemoryStageRunStore());
    const agent: CodingAgent = {
      id: "cursor",
      async run() {
        return {
          pr_ready: false,
          status: "failed",
          error_class: "cli_failed",
          logs: "boom",
          usage: { provider: "cursor", model_id: "composer", input_tokens: 4, output_tokens: 1 },
        };
      },
    };
    const errors = capture("error");
    try {
      await expect(
        processStageJob(
          { taskId: "t-1", sessionId: "s-1", stage: "plan" },
          {
            cursors: new InMemoryStepCursorStore(),
            runLog,
            handler: createProductionStageHandler({
              env: { CURSOR_API_KEY: "test-key", OPTIO_NEW_CODING_BACKEND: "cursor" },
              worktrees: memoryWorktrees("t-1"),
              codingAgent: agent,
            }),
          },
        ),
      ).rejects.toThrow(/coding agent cursor failed/);
    } finally {
      errors.restore();
    }

    const stage = (await runLog.inspect("t-1")).stages[0];
    expect(stage?.status).toBe("failed");
    expect(stage?.reason).toContain("coding agent cursor failed");
    expect(stage?.usage).toEqual([
      {
        agentId: "agents/plan",
        provider: "cursor",
        modelId: "composer",
        inputTokens: 4,
        outputTokens: 1,
      },
    ]);
    expect(stage?.actions.map((action) => [action.step, action.status])).toEqual([
      ["ack_session", "ok"],
      ["invoke_planner", "error"],
    ]);
    expect(jsonLines(errors.lines, "stage.failed")[0]).toMatchObject({
      stage: "plan",
      step: "invoke_planner",
    });
  });

  it("returns adapter usage from the agent loop only when the adapter sent it", async () => {
    const withUsage = await runAgentLoop(
      { prompt: "plan the work" },
      {
        async complete() {
          return { text: "ok", usage: { input_tokens: 8, output_tokens: 2, cost_usd: 0.01 } };
        },
      },
    );
    const without = await runAgentLoop(
      { prompt: "plan the work" },
      {
        async complete() {
          return { text: "ok" };
        },
      },
    );
    expect(withUsage.usage).toEqual({ input_tokens: 8, output_tokens: 2, cost_usd: 0.01 });
    expect(without.usage).toBeUndefined();
  });

  it("puts coding-agent token counts on the agent.run span", async () => {
    const tracer = createStageTracer();
    const agent = createCursorAdapter({
      tracer,
      env: { CURSOR_API_KEY: "cursor-test-key" },
      runner: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          usage: {
            input_tokens: 11,
            output_tokens: 22,
            cached_tokens: 3,
            cost_usd: 0.04,
            model_id: "composer-2",
          },
        }),
        stderr: "",
        timedOut: false,
        signal: null,
      }),
    });

    await agent.run(adapterInput());
    const span = tracer.finished().find((item) => item.name === "agent.run");
    expect(span?.attributes).toMatchObject({
      task_id: "t-span",
      provider: "cursor",
      model_id: "composer-2",
      input_tokens: "11",
      output_tokens: "22",
      cached_tokens: "3",
      cost_usd: "0.04",
    });
    await tracer.shutdown();
  });

  it("round-trips a stage row through the SQL store", async () => {
    const ddl = loadPipelineStageRunDdl();
    expect(ddl).toContain("CREATE TABLE IF NOT EXISTS pipeline_stage_run");
    expect(ddl).toContain("PRIMARY KEY (task_id, session_id, stage)");
    expect(ddl).toContain("pipeline_stage_run_task_idx");

    const rows = new Map<string, unknown[]>();
    const db: SqlExecutor = {
      async query(sql, params = []) {
        if (sql.startsWith("INSERT INTO pipeline_stage_run")) {
          rows.set(`${String(params[0])}|${String(params[1])}|${String(params[2])}`, [...params]);
          return { rows: [] };
        }
        if (sql.includes("session_id = $2")) {
          const stored = rows.get(`${String(params[0])}|${String(params[1])}|${String(params[2])}`);
          return { rows: stored ? [sqlRow(stored)] : [] };
        }
        if (sql.startsWith("SELECT") && sql.includes("WHERE task_id = $1")) {
          const matched = [...rows.values()].filter((stored) => stored[0] === params[0]);
          return { rows: matched.map(sqlRow) };
        }
        throw new Error(`unexpected sql: ${sql}`);
      },
    };

    const runLog = createStageRunLog(createSqlStageRunStore(db));
    await runLog.beginStage({
      taskId: "t-1",
      sessionId: "s-1",
      stage: "review",
      startedAt: "2026-09-26T12:00:00.000Z",
    });
    await runLog.recordUsage({
      taskId: "t-1",
      sessionId: "s-1",
      stage: "review",
      agentId: "agents/review",
      provider: "codex",
      inputTokens: 9,
      costUsd: 0.01,
    });
    await runLog.recordAction({
      taskId: "t-1",
      sessionId: "s-1",
      stage: "review",
      step: "invoke_review",
      agentId: "agents/review",
      name: "invoke_review",
      status: "error",
      reason: "review rejected the diff",
      at: "2026-09-26T12:00:01.500Z",
    });
    await runLog.finishStage({
      taskId: "t-1",
      sessionId: "s-1",
      stage: "review",
      endedAt: "2026-09-26T12:00:01.500Z",
      durationMs: 1500,
      status: "failed",
      reason: "review rejected the diff",
    });

    expect(await runLog.inspect("t-1")).toEqual({
      taskId: "t-1",
      stages: [
        {
          sessionId: "s-1",
          stage: "review",
          startedAt: "2026-09-26T12:00:00.000Z",
          endedAt: "2026-09-26T12:00:01.500Z",
          durationMs: 1500,
          status: "failed",
          reason: "review rejected the diff",
          usage: [{ agentId: "agents/review", provider: "codex", inputTokens: 9, costUsd: 0.01 }],
          actions: [
            {
              at: "2026-09-26T12:00:01.500Z",
              sessionId: "s-1",
              stage: "review",
              step: "invoke_review",
              agentId: "agents/review",
              name: "invoke_review",
              status: "error",
              reason: "review rejected the diff",
            },
          ],
        },
      ],
    });
  });

  it("serves agent actions for a task id and stays hidden until a reader is wired", async () => {
    const runLog = createStageRunLog(new InMemoryStageRunStore());
    await processStageJob(
      { taskId: "t-1", sessionId: "s-1", stage: "plan" },
      {
        cursors: new InMemoryStepCursorStore(),
        handler: noopHandler(),
        runLog,
        now: tickingClock(),
      },
    );

    const server = createIntakeServer({
      enqueuer: { async add() {} },
      readTaskActions: (taskId) => runLog.inspect(taskId),
    });
    servers.push(server);
    const base = await listen(server);

    const body = await fetch(`${base}/tasks/t-1/actions`);
    expect(body.status).toBe(200);
    expect(await body.json()).toEqual(await runLog.inspect("t-1"));

    const missing = await fetch(`${base}/tasks/missing/actions`);
    expect(missing.status).toBe(200);
    expect(await missing.json()).toEqual({ taskId: "missing", stages: [] });

    const posted = await fetch(`${base}/tasks/t-1/actions`, { method: "POST" });
    expect(posted.status).toBe(405);

    const colon = await fetch(`${base}/tasks/${encodeURIComponent("t:1")}/actions`);
    expect(colon.status).toBe(400);

    const unwired = createIntakeServer({ enqueuer: { async add() {} } });
    servers.push(unwired);
    const hidden = await fetch(`${await listen(unwired)}/tasks/t-1/actions`);
    expect(hidden.status).toBe(404);
    expect(await hidden.json()).toEqual({
      error: "not_found",
      message: "Task actions are unavailable",
    });
  });
});

function sqlRow(params: unknown[]): Record<string, unknown> {
  return {
    task_id: params[0],
    session_id: params[1],
    stage: params[2],
    started_at: new Date(String(params[3])),
    ended_at: params[4],
    duration_ms: params[5] == null ? null : String(params[5]),
    status: params[6],
    reason: params[7],
    usage: params[8],
    actions: params[9],
  };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}
