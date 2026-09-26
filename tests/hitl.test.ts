import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  ApprovalRejectedError,
  ApprovalReplanError,
  ApprovalRequiredError,
  InMemoryHitlStore,
  InMemoryStepCursorStore,
  applyHitlDecision,
  createHitlQueuePort,
  createIntakeServer,
  delayJobForApproval,
  loadHitlApprovalDdl,
  loadHitlConfig,
  processStageJob,
  type HitlJobQueue,
  type HitlNotifyEvent,
  type StageStepHandler,
  type WorktreeLifecycle,
} from "../src/index.js";

const identity = { taskId: "t-1", sessionId: "s-1" };

function handler(calls: string[], confidence = 0.2): StageStepHandler {
  return {
    async run(ctx) {
      calls.push(`${ctx.stage}:${ctx.step}`);
      if (ctx.step === "invoke_planner") return { confidence };
      return undefined;
    },
  };
}

function binding(options?: {
  now?: () => Date;
  events?: HitlNotifyEvent[];
  resumed?: string[];
  env?: NodeJS.ProcessEnv;
  yaml?: string;
}) {
  const state = new InMemoryHitlStore();
  const resumed = options?.resumed ?? [];
  return {
    state,
    resumed,
    hitl: {
      config: loadHitlConfig(options?.env ?? {}, options?.yaml),
      store: state,
      signals: state,
      now: options?.now,
      notify: (event: HitlNotifyEvent) => {
        options?.events?.push(event);
      },
      queue: {
        async resumePaused(stage: string) {
          resumed.push(stage);
        },
        async requeuePlan() {
          resumed.push("plan");
        },
      },
    },
  };
}

function worktrees(events: string[]): WorktreeLifecycle {
  return {
    async create(taskId) {
      events.push("create");
      return {
        taskId,
        worktreeId: `wt-${taskId}`,
        path: `/tmp/${taskId}`,
        branch: `task/${taskId}`,
      };
    },
    async reap() {
      events.push("reap");
      return { taskId: "t-1", action: "retained", path: "/tmp/t-1", reason: "failure" };
    },
  };
}

describe("human approval gates", () => {
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

  it("pauses implement when planner confidence is low, then approve resumes the stage", async () => {
    const calls: string[] = [];
    const events: HitlNotifyEvent[] = [];
    const resumed: string[] = [];
    const { hitl } = binding({ events, resumed });
    const cursors = new InMemoryStepCursorStore();
    const deps = { cursors, handler: handler(calls, 0.2), hitl };

    await processStageJob({ ...identity, stage: "plan" }, deps);
    await expect(processStageJob({ ...identity, stage: "implement" }, deps)).rejects.toBeInstanceOf(
      ApprovalRequiredError,
    );
    expect(calls).toEqual(["plan:ack_session", "plan:invoke_planner"]);
    expect(events.map((event) => event.kind)).toEqual(["pause"]);
    expect(events[0]?.reason).toBe("awaiting_human");

    const decided = await applyHitlDecision(
      { ...identity, point: "plan", action: "approve" },
      hitl,
      cursors,
    );
    expect(decided).toMatchObject({ status: "approved", source: "human", reason: "human_approve" });
    expect(resumed).toEqual(["implement"]);

    const resumedStage = await processStageJob({ ...identity, stage: "implement" }, deps);
    expect(resumedStage.status).toBe("completed");
    expect(calls).toContain("implement:invoke_implementation");
  });

  it("records a policy approval when confidence is high and does not pause", async () => {
    const calls: string[] = [];
    const events: HitlNotifyEvent[] = [];
    const { hitl, state } = binding({ events });
    const cursors = new InMemoryStepCursorStore();
    const deps = { cursors, handler: handler(calls, 0.8), hitl };

    await processStageJob({ ...identity, stage: "plan" }, deps);
    const result = await processStageJob({ ...identity, stage: "implement" }, deps);
    expect(result.status).toBe("completed");
    expect(calls).toContain("implement:invoke_implementation");
    const record = await state.get("t-1", "s-1", "plan");
    expect(record).toMatchObject({
      status: "approved",
      source: "policy",
      reason: "confidence_at_or_above_threshold",
      confidence: 0.8,
    });
    expect(events.map((event) => event.kind)).toEqual(["approved"]);
  });

  it("does not auto-approve when the plan gate is always on, even at confidence 1", async () => {
    const calls: string[] = [];
    const { hitl, state } = binding({ env: { OPTIO_HITL_PLAN: "always" } });
    const cursors = new InMemoryStepCursorStore();
    const deps = { cursors, handler: handler(calls, 1), hitl };

    await processStageJob({ ...identity, stage: "plan" }, deps);
    await expect(processStageJob({ ...identity, stage: "implement" }, deps)).rejects.toBeInstanceOf(
      ApprovalRequiredError,
    );
    expect(calls).not.toContain("implement:invoke_implementation");
    expect(await state.get("t-1", "s-1", "plan")).toMatchObject({ status: "pending" });
  });

  it("pauses when confidence is missing", async () => {
    const calls: string[] = [];
    const { hitl } = binding({});
    const cursors = new InMemoryStepCursorStore();
    await processStageJob(
      { ...identity, stage: "plan" },
      { cursors, handler: { async run() {} }, hitl },
    );
    await expect(
      processStageJob(
        { ...identity, stage: "implement" },
        { cursors, handler: handler(calls), hitl },
      ),
    ).rejects.toBeInstanceOf(ApprovalRequiredError);
    expect(calls).toEqual([]);
  });

  it("notifies on timeout and stays unapproved", async () => {
    let now = Date.parse("2026-09-26T00:00:00.000Z");
    const events: HitlNotifyEvent[] = [];
    const { hitl, state } = binding({
      events,
      now: () => new Date(now),
      env: { OPTIO_HITL_TIMEOUT_MS: "1000" },
    });
    const cursors = new InMemoryStepCursorStore();
    const deps = { cursors, handler: handler([], 0.1), hitl };

    await processStageJob({ ...identity, stage: "plan" }, deps);
    await expect(processStageJob({ ...identity, stage: "implement" }, deps)).rejects.toBeInstanceOf(
      ApprovalRequiredError,
    );
    now += 1000;
    await expect(processStageJob({ ...identity, stage: "implement" }, deps)).rejects.toBeInstanceOf(
      ApprovalRequiredError,
    );
    expect(await state.get("t-1", "s-1", "plan")).toMatchObject({
      status: "timed_out",
      reason: "timeout_no_auto_approve",
      source: "timeout",
    });
    expect(events.map((event) => event.kind)).toEqual(["pause", "timeout"]);

    now += 60_000;
    await expect(processStageJob({ ...identity, stage: "implement" }, deps)).rejects.toBeInstanceOf(
      ApprovalRequiredError,
    );
    expect(events.filter((event) => event.kind === "timeout")).toHaveLength(1);
    expect((await state.get("t-1", "s-1", "plan"))?.status).not.toBe("approved");
  });

  it("rejects without running merge steps or reaping the worktree", async () => {
    const calls: string[] = [];
    const treeEvents: string[] = [];
    const { hitl } = binding({ env: { OPTIO_HITL_PLAN: "off" } });
    const cursors = new InMemoryStepCursorStore();
    const deps = {
      cursors,
      handler: handler(calls, 1),
      hitl,
      worktrees: worktrees(treeEvents),
    };

    await processStageJob({ ...identity, stage: "plan" }, deps);
    await processStageJob({ ...identity, stage: "implement" }, deps);
    await processStageJob({ ...identity, stage: "review" }, deps);
    const ready = await processStageJob({ ...identity, stage: "ready" }, deps);
    expect(ready.status).toBe("completed");
    expect(calls).toContain("ready:open_pr");
    expect(calls).toContain("ready:record_ci_wait");
    await expect(processStageJob({ ...identity, stage: "merge" }, deps)).rejects.toBeInstanceOf(
      ApprovalRequiredError,
    );
    expect(calls).not.toContain("merge:merge_branch");
    expect(treeEvents).toEqual(["create"]);

    await applyHitlDecision({ ...identity, point: "merge", action: "reject" }, hitl, cursors);
    await expect(processStageJob({ ...identity, stage: "merge" }, deps)).rejects.toBeInstanceOf(
      ApprovalRejectedError,
    );
    expect(calls).not.toContain("merge:merge_branch");
    expect(treeEvents).toEqual(["create"]);
  });

  it("replans without dropping the worktree, then runs the planner again", async () => {
    const calls: string[] = [];
    const treeEvents: string[] = [];
    const resumed: string[] = [];
    let plannerRuns = 0;
    const { hitl, state } = binding({ resumed });
    const cursors = new InMemoryStepCursorStore();
    const deps = {
      cursors,
      hitl,
      worktrees: worktrees(treeEvents),
      handler: {
        async run(ctx: { stage: string; step: string }) {
          calls.push(`${ctx.stage}:${ctx.step}`);
          if (ctx.step === "invoke_planner") {
            plannerRuns += 1;
            return { confidence: plannerRuns === 1 ? 0.1 : 0.95 };
          }
          return undefined;
        },
      } satisfies StageStepHandler,
    };

    await processStageJob({ ...identity, stage: "plan" }, deps);
    await expect(processStageJob({ ...identity, stage: "implement" }, deps)).rejects.toBeInstanceOf(
      ApprovalRequiredError,
    );
    await applyHitlDecision({ ...identity, point: "plan", action: "replan" }, hitl, cursors);
    expect(await cursors.get("t-1", "s-1", "plan")).toMatchObject({
      status: "pending",
      nextStepIndex: 0,
    });
    expect(resumed).toEqual(["plan", "implement"]);
    await expect(processStageJob({ ...identity, stage: "implement" }, deps)).rejects.toBeInstanceOf(
      ApprovalReplanError,
    );
    expect(treeEvents).toEqual([]);

    resumed.length = 0;
    await processStageJob({ ...identity, stage: "plan" }, deps);
    expect(await state.get("t-1", "s-1", "plan")).toBeUndefined();
    expect(resumed).toEqual(["implement"]);
    const implemented = await processStageJob({ ...identity, stage: "implement" }, deps);
    expect(implemented.status).toBe("completed");
    expect(treeEvents).toEqual(["create"]);
  });

  it("runs ready through CI wait, then pauses merge until merge is approved", async () => {
    const calls: string[] = [];
    const resumed: string[] = [];
    const { hitl } = binding({ env: { OPTIO_HITL_PLAN: "off" }, resumed });
    const cursors = new InMemoryStepCursorStore();
    const deps = { cursors, handler: handler(calls), hitl };
    for (const stage of ["plan", "implement", "review"] as const) {
      await processStageJob({ ...identity, stage }, deps);
    }
    const ready = await processStageJob({ ...identity, stage: "ready" }, deps);
    expect(ready.status).toBe("completed");
    expect(calls).toContain("ready:open_pr");
    expect(calls).toContain("ready:record_ci_wait");
    await expect(processStageJob({ ...identity, stage: "merge" }, deps)).rejects.toBeInstanceOf(
      ApprovalRequiredError,
    );
    expect(calls).not.toContain("merge:merge_branch");
    await applyHitlDecision({ ...identity, point: "merge", action: "approve" }, hitl, cursors);
    expect(resumed).toEqual(["merge"]);
    await processStageJob({ ...identity, stage: "merge" }, deps);
    expect(calls).toContain("merge:merge_branch");
    expect(calls).toContain("merge:record_cleanup");
  });

  it("serves pause then approve over HTTP", async () => {
    const calls: string[] = [];
    const { hitl, state } = binding({});
    const cursors = new InMemoryStepCursorStore();
    const server = createIntakeServer({
      enqueuer: { async add() {} },
      approvals: {
        list: (taskId, sessionId) => state.list(taskId, sessionId),
        decide: (input) => applyHitlDecision(input, hitl, cursors),
      },
    });
    servers.push(server);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    const deps = { cursors, handler: handler(calls, 0.1), hitl };
    await processStageJob({ ...identity, stage: "plan" }, deps);
    await expect(processStageJob({ ...identity, stage: "implement" }, deps)).rejects.toBeInstanceOf(
      ApprovalRequiredError,
    );

    const listed = await fetch(`http://127.0.0.1:${port}/approvals?taskId=t-1&sessionId=s-1`);
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { approvals: { status: string }[] };
    expect(body.approvals[0]?.status).toBe("pending");

    const decided = await fetch(`http://127.0.0.1:${port}/approvals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId: "t-1", sessionId: "s-1", point: "plan", action: "approve" }),
    });
    expect(decided.status).toBe(200);
    await processStageJob({ ...identity, stage: "implement" }, deps);
    expect(calls).toContain("implement:invoke_implementation");
  });

  it("delays a BullMQ job for a required approval and leaves other errors alone", async () => {
    const moves: number[] = [];
    const paused = await delayJobForApproval(
      new ApprovalRequiredError({
        taskId: "t-1",
        sessionId: "s-1",
        point: "plan",
        status: "pending",
        reason: "awaiting_human",
        source: "gate",
        requestedAt: "2026-09-26T00:00:00.000Z",
        timeoutAt: "2026-09-27T00:00:00.000Z",
      }),
      {
        async moveToDelayed(when) {
          moves.push(when);
        },
      },
      "token-1",
      1000,
    );
    expect(paused).toBe(true);
    expect(moves).toHaveLength(1);
    expect(
      await delayJobForApproval(new Error("boom"), { async moveToDelayed() {} }, "t", 1000),
    ).toBe(false);
  });

  it("re-adds a finished plan job and promotes a delayed implement job", async () => {
    const added: string[] = [];
    let implementState = "delayed";
    const queues = {
      plan: fakeQueue("completed", added, "plan"),
      implement: {
        async getJob() {
          return {
            data: { taskId: "t-1", sessionId: "s-1", stage: "implement" as const },
            async getState() {
              return implementState;
            },
            async promote() {
              implementState = "waiting";
            },
            async remove() {
              implementState = "removed";
            },
          };
        },
        async add(_name: string, _data: unknown, opts: { jobId: string }) {
          added.push(opts.jobId);
        },
      },
      merge: fakeQueue("waiting-children", added, "merge"),
    };
    const port = createHitlQueuePort(queues);
    await port.requeuePlan(identity);
    expect(added).toEqual(["s-1__plan"]);
    await port.resumePaused("implement", identity);
    expect(implementState).toBe("waiting");
    expect(added).toEqual(["s-1__plan"]);
    await port.resumePaused("merge", identity);
    expect(added).toEqual(["s-1__plan"]);
  });

  it("loads the workflow defaults and keeps the approval table durable", () => {
    const yaml = readFileSync("workflows/default-task.yaml", "utf8");
    const config = loadHitlConfig({}, yaml);
    expect(config.plan.mode).toBe("when_confidence_low");
    expect(config.merge.mode).toBe("always");
    expect(config.plan.confidenceThreshold).toBe(0.8);
    expect(config.timeoutMs).toBe(86_400_000);
    expect(loadHitlConfig({ OPTIO_HITL_MERGE: "off" }, yaml).merge.mode).toBe("off");
    expect(() => loadHitlConfig({ OPTIO_HITL_PLAN: "maybe" })).toThrow(/OPTIO_HITL_PLAN/);
    const ddl = loadHitlApprovalDdl();
    expect(ddl).toContain("CREATE TABLE IF NOT EXISTS hitl_approval");
    expect(ddl).toContain("timed_out");
    expect(ddl).not.toMatch(/sk-|ghp_|api_key/i);
  });
});

function fakeQueue(state: string, added: string[], stage: "plan" | "merge"): HitlJobQueue {
  let current = state;
  return {
    async getJob() {
      if (current === "removed") return undefined;
      return {
        data: { taskId: "t-1", sessionId: "s-1", stage },
        async getState() {
          return current;
        },
        async promote() {
          current = "waiting";
        },
        async remove() {
          current = "removed";
        },
      };
    },
    async add(_name, _data, opts) {
      added.push(opts.jobId);
    },
  };
}
