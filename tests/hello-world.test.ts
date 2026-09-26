import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  HELLO_WORLD_RESPONSE,
  InMemoryStepCursorStore,
  createIntakeServer,
  readPlanStage,
  runHelloWorldPlan,
} from "../src/index.js";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

describe("hello-world intake → plan", () => {
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

  it("enqueues intake and completes only the plan stage", async () => {
    const cursors = new InMemoryStepCursorStore();
    const proof = await runHelloWorldPlan(
      { taskId: "hello-1", title: "hello", description: "world" },
      cursors,
    );

    expect(proof).toMatchObject({
      taskId: "hello-1",
      sessionId: "hello-1",
      jobId: "hello-1__plan",
      queue: "optio.plan",
      steps: ["plan:ack_session", "plan:invoke_planner"],
    });
    expect(proof.plan).toEqual({
      ok: true,
      hello: "world",
      taskId: "hello-1",
      sessionId: "hello-1",
      stage: "plan",
      queue: "optio.plan",
      status: "completed",
      nextStepIndex: 2,
      progressed: true,
    });
    expect(await cursors.get("hello-1", "hello-1", "implement")).toBeUndefined();
  });

  it("serves GET /hello and GET /hello/plan from the plan cursor", async () => {
    const cursors = new InMemoryStepCursorStore();
    const server = createIntakeServer({
      enqueuer: { async add() {} },
      readPlanStage: (taskId, sessionId) => readPlanStage(cursors, taskId, sessionId),
    });
    servers.push(server);
    const base = await listen(server);

    const waiting = await fetch(`${base}/hello/plan?taskId=hello-1`);
    expect(waiting.status).toBe(200);
    expect(await waiting.json()).toMatchObject({ status: "queued", progressed: false });

    await runHelloWorldPlan({ taskId: "hello-1", title: "hello" }, cursors);

    const hello = await fetch(`${base}/hello`);
    expect(hello.status).toBe(200);
    expect(await hello.json()).toEqual(HELLO_WORLD_RESPONSE);

    const plan = await fetch(`${base}/hello/plan?taskId=hello-1&sessionId=hello-1`);
    expect(plan.status).toBe(200);
    expect(await plan.json()).toMatchObject({
      progressed: true,
      status: "completed",
      stage: "plan",
      nextStepIndex: 2,
    });
  });

  it("rejects a non-GET hello and a plan id that cannot be a BullMQ job id", async () => {
    const server = createIntakeServer({
      enqueuer: { async add() {} },
      readPlanStage: (taskId, sessionId) =>
        readPlanStage(new InMemoryStepCursorStore(), taskId, sessionId),
    });
    servers.push(server);
    const base = await listen(server);

    const posted = await fetch(`${base}/hello`, { method: "POST" });
    expect(posted.status).toBe(405);

    const colonId = await fetch(`${base}/hello/plan?taskId=t:1`);
    expect(colonId.status).toBe(400);
    const body = (await colonId.json()) as { issues: { path: string; message: string }[] };
    expect(body.issues).toContainEqual({
      path: "taskId",
      message: "must not contain ':'",
    });
  });

  it("keeps GET /hello/plan hidden until a cursor reader is wired", async () => {
    const server = createIntakeServer({ enqueuer: { async add() {} } });
    servers.push(server);
    const base = await listen(server);

    const hello = await fetch(`${base}/hello`);
    expect(hello.status).toBe(200);

    const plan = await fetch(`${base}/hello/plan?taskId=hello-1`);
    expect(plan.status).toBe(404);
    expect(await plan.json()).toEqual({
      error: "not_found",
      message: "Plan progress is unavailable",
    });
  });

  it("documents the kit-harness compose command and skips when orchestrator is down", () => {
    const script = readFileSync(new URL("../scripts/hello-world-e2e.sh", import.meta.url), "utf8");
    const kit = readFileSync(new URL("../docs/kit-harness.md", import.meta.url), "utf8");
    expect(script).toContain(
      "docker compose --profile full --profile harness up -d --build orchestrator",
    );
    expect(script).toContain("/hello/plan");
    expect(kit).toContain(
      "docker compose --profile full --profile harness up -d --build orchestrator",
    );
    expect(kit).toContain("scripts/hello-world-e2e.sh");

    const skipped = execFileSync("bash", ["scripts/hello-world-e2e.sh"], {
      encoding: "utf8",
      env: {
        ...process.env,
        ORCHESTRATOR_URL: "http://127.0.0.1:9",
        HELLO_WORLD_E2E: "0",
      },
    });
    expect(skipped).toContain("[hello-world] SKIP:");

    expect(() =>
      execFileSync("bash", ["scripts/hello-world-e2e.sh"], {
        encoding: "utf8",
        env: {
          ...process.env,
          ORCHESTRATOR_URL: "http://127.0.0.1:9",
          HELLO_WORLD_E2E: "1",
        },
      }),
    ).toThrow(/orchestrator/);
  });
});
