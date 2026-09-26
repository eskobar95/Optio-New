import { describe, expect, it } from "vitest";
import type { FlowJob } from "bullmq";
import {
  STAGE_QUEUES,
  StageNotReadyError,
  InMemoryStepCursorStore,
  buildPipelineFlow,
  createAgentStageHandler,
  createSqlStepCursorStore,
  enqueueIntakePipeline,
  loadPipelineStepCursorDdl,
  processStageJob,
  runPipeline,
  startStageGraph,
  type SqlExecutor,
  type StageStepHandler,
  type StepCursor,
} from "../src/index.js";

const identity = { taskId: "t-1", sessionId: "s-1" };

const happySteps = [
  "plan:ack_session",
  "plan:invoke_planner",
  "implement:invoke_implementation",
  "implement:record_diff",
  "review:invoke_review",
  "review:record_verdict",
  "ready:open_pr",
  "ready:record_ci_wait",
  "merge:merge_branch",
  "merge:record_cleanup",
] as const;

function chain(flow: FlowJob): FlowJob[] {
  const nodes: FlowJob[] = [];
  let current: FlowJob | undefined = flow;
  while (current) {
    nodes.push(current);
    current = current.children?.[0] as FlowJob | undefined;
  }
  return nodes;
}

function recordingHandler(calls: string[], crashOn?: string): StageStepHandler {
  let armed = crashOn !== undefined;
  return {
    async run(ctx) {
      const key = `${ctx.stage}:${ctx.step}`;
      if (armed && key === crashOn) {
        armed = false;
        throw new Error("worker crashed");
      }
      calls.push(key);
    },
  };
}

describe("BullMQ stage graph", () => {
  it("chains plan → implement → review → ready → merge so each stage waits on the previous job", () => {
    expect(Object.values(STAGE_QUEUES)).toEqual([
      "optio.plan",
      "optio.implement",
      "optio.review",
      "optio.ready",
      "optio.merge",
    ]);

    const flow = buildPipelineFlow(identity);
    const nodes = chain(flow);

    expect(nodes.map((node) => node.queueName)).toEqual([
      "optio.merge",
      "optio.ready",
      "optio.review",
      "optio.implement",
      "optio.plan",
    ]);
    expect(nodes.map((node) => node.data)).toEqual([
      { taskId: "t-1", sessionId: "s-1", stage: "merge" },
      { taskId: "t-1", sessionId: "s-1", stage: "ready" },
      { taskId: "t-1", sessionId: "s-1", stage: "review" },
      { taskId: "t-1", sessionId: "s-1", stage: "implement" },
      { taskId: "t-1", sessionId: "s-1", stage: "plan" },
    ]);
    expect(nodes.map((node) => node.name)).toEqual([
      "merge",
      "ready",
      "review",
      "implement",
      "plan",
    ]);
    expect(nodes.map((node) => node.opts?.jobId)).toEqual([
      "s-1__merge",
      "s-1__ready",
      "s-1__review",
      "s-1__implement",
      "s-1__plan",
    ]);
    for (const node of nodes.slice(0, -1)) {
      expect(node.children).toHaveLength(1);
      expect(node.opts?.attempts).toBe(5);
    }
    expect(nodes.at(-1)?.children).toBeUndefined();
    expect(nodes.at(-1)?.opts?.attempts).toBe(5);
    expect(() => buildPipelineFlow({ taskId: "", sessionId: "s-1" })).toThrow();
    expect(() => buildPipelineFlow({ taskId: "t-1", sessionId: "s:1" })).toThrow(/:/);
  });

  it("runs the agent loop once per step on the happy path", async () => {
    const prompts: string[] = [];
    const result = await runPipeline(identity, {
      cursors: new InMemoryStepCursorStore(),
      handler: createAgentStageHandler({
        async complete(request) {
          prompts.push(request.prompt);
          return { text: "ok" };
        },
      }),
    });

    expect(prompts).toEqual(happySteps.map((step) => `${step} task=t-1`));
    expect(result.stages.map((stage) => stage.stage)).toEqual([
      "plan",
      "implement",
      "review",
      "ready",
      "merge",
    ]);
    expect(result.stages.every((stage) => stage.status === "completed")).toBe(true);
  });

  it("refuses a later stage until the previous stage cursor is completed", async () => {
    const calls: string[] = [];
    await expect(
      processStageJob(
        { ...identity, stage: "implement" },
        { cursors: new InMemoryStepCursorStore(), handler: recordingHandler(calls) },
      ),
    ).rejects.toBeInstanceOf(StageNotReadyError);
    expect(calls).toEqual([]);
  });

  it("resumes the crashed step and does not repeat completed steps or earlier stages", async () => {
    const calls: string[] = [];
    const cursors = new InMemoryStepCursorStore();
    const deps = { cursors, handler: recordingHandler(calls, "implement:record_diff") };

    await expect(runPipeline(identity, deps)).rejects.toThrow(/worker crashed/);
    expect(calls).toEqual([
      "plan:ack_session",
      "plan:invoke_planner",
      "implement:invoke_implementation",
    ]);

    calls.length = 0;
    const resumed = await runPipeline(identity, {
      cursors,
      handler: recordingHandler(calls),
    });

    expect(calls).toEqual([
      "implement:record_diff",
      "review:invoke_review",
      "review:record_verdict",
      "ready:open_pr",
      "ready:record_ci_wait",
      "merge:merge_branch",
      "merge:record_cleanup",
    ]);
    expect(resumed.stages.map((stage) => stage.status)).toEqual([
      "completed",
      "completed",
      "completed",
      "completed",
      "completed",
    ]);

    calls.length = 0;
    await runPipeline(identity, { cursors, handler: recordingHandler(calls) });
    expect(calls).toEqual([]);
  });

  it("reruns a step when its cursor write fails, then continues from that step", async () => {
    const calls: string[] = [];
    const inner = new InMemoryStepCursorStore();
    let saves = 0;
    const cursors = {
      get(taskId: string, sessionId: string, stage: StepCursor["stage"]) {
        return inner.get(taskId, sessionId, stage);
      },
      async save(cursor: StepCursor) {
        saves += 1;
        if (saves === 2) {
          throw new Error("cursor write failed");
        }
        await inner.save(cursor);
      },
    };

    await expect(
      processStageJob(
        { ...identity, stage: "plan" },
        { cursors, handler: recordingHandler(calls) },
      ),
    ).rejects.toThrow(/cursor write failed/);
    expect(calls).toEqual(["plan:ack_session"]);

    calls.length = 0;
    await processStageJob(
      { ...identity, stage: "plan" },
      { cursors: inner, handler: recordingHandler(calls) },
    );
    expect(calls).toEqual(["plan:ack_session", "plan:invoke_planner"]);
  });
});

describe("Postgres step cursor", () => {
  it("stores the resume index in pipeline_step_cursor", () => {
    const ddl = loadPipelineStepCursorDdl();
    expect(ddl).toContain("CREATE TABLE IF NOT EXISTS pipeline_step_cursor");
    expect(ddl).toContain("PRIMARY KEY (task_id, session_id, stage)");
    for (const column of [
      "task_id",
      "session_id",
      "stage",
      "next_step_index",
      "status",
      "updated_at",
    ]) {
      expect(ddl).toContain(column);
    }
  });

  it("resumes through the SQL cursor store and coerces numeric strings", async () => {
    const rows = new Map<string, Record<string, unknown>>();
    const db: SqlExecutor = {
      async query(sql, params = []) {
        if (sql.startsWith("INSERT")) {
          const [taskId, sessionId, stage, nextStepIndex, status, updatedAt] = params;
          rows.set(`${String(taskId)}|${String(sessionId)}|${String(stage)}`, {
            task_id: taskId,
            session_id: sessionId,
            stage,
            next_step_index: nextStepIndex,
            status,
            updated_at: updatedAt,
          });
          return { rows: [] };
        }
        if (sql.startsWith("SELECT")) {
          const [taskId, sessionId, stage] = params;
          const row = rows.get(`${String(taskId)}|${String(sessionId)}|${String(stage)}`);
          if (!row) {
            return { rows: [] };
          }
          return {
            rows: [{ ...row, next_step_index: String(row.next_step_index) }],
          };
        }
        throw new Error(`unexpected sql: ${sql}`);
      },
    };

    const calls: string[] = [];
    const cursors = createSqlStepCursorStore(db);
    await expect(
      processStageJob(
        { ...identity, stage: "plan" },
        { cursors, handler: recordingHandler(calls, "plan:invoke_planner") },
      ),
    ).rejects.toThrow(/worker crashed/);

    calls.length = 0;
    const result = await processStageJob(
      { ...identity, stage: "plan" },
      { cursors, handler: recordingHandler(calls) },
    );
    expect(calls).toEqual(["plan:invoke_planner"]);
    expect(result).toMatchObject({ stage: "plan", status: "completed", nextStepIndex: 2 });
  });
});

describe("intake enqueue and workers", () => {
  it("enqueues one flow for a validated intake task", async () => {
    const added: FlowJob[] = [];
    const enqueued = await enqueueIntakePipeline(
      { taskId: "t-9", title: "Ship graph", description: "issue 2" },
      {
        async add(flow) {
          added.push(flow);
          return { id: "flow-1" };
        },
      },
    );

    expect(enqueued).toMatchObject({ taskId: "t-9", sessionId: "t-9" });
    expect(added).toHaveLength(1);
    const root = added[0];
    if (!root) {
      throw new Error("missing flow");
    }
    expect(chain(root).at(-1)?.queueName).toBe("optio.plan");
    expect(root.queueName).toBe("optio.merge");

    await expect(
      enqueueIntakePipeline({ taskId: "", title: "x" }, { async add() {} }),
    ).rejects.toThrow();
  });

  it("registers one worker per stage queue and that worker runs the stage job", async () => {
    const calls: string[] = [];
    const processors = new Map<string, (data: unknown) => Promise<unknown>>();
    const handles = startStageGraph(
      {
        cursors: new InMemoryStepCursorStore(),
        handler: recordingHandler(calls),
      },
      {
        create(queueName, processor) {
          processors.set(queueName, processor);
          return { async close() {} };
        },
      },
    );

    expect(handles).toHaveLength(5);
    expect([...processors.keys()]).toEqual([
      "optio.plan",
      "optio.implement",
      "optio.review",
      "optio.ready",
      "optio.merge",
    ]);

    const plan = processors.get("optio.plan");
    expect(plan).toBeTypeOf("function");
    await plan?.({ ...identity, stage: "plan" });
    expect(calls).toEqual(["plan:ack_session", "plan:invoke_planner"]);

    const review = processors.get("optio.review");
    await expect(review?.({ ...identity, stage: "plan" })).rejects.toThrow(
      /optio.review received stage plan/,
    );
  });
});
