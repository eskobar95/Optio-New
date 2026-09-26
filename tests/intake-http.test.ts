import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { FlowJob } from "bullmq";
import { afterEach, describe, expect, it } from "vitest";
import { createIntakeServer } from "../src/index.js";

function planJob(flow: FlowJob): FlowJob {
  let current = flow;
  while (current.children?.[0]) {
    current = current.children[0] as FlowJob;
  }
  return current;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

describe("POST /intake", () => {
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

  it("accepts a task brief and metadata, enqueues the plan job, and returns its id", async () => {
    const added: FlowJob[] = [];
    const server = createIntakeServer({
      enqueuer: {
        async add(flow) {
          added.push(flow);
        },
      },
    });
    servers.push(server);
    const base = await listen(server);

    const response = await fetch(`${base}/intake`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        brief: { title: "Add intake", description: "Enqueue the plan stage" },
        metadata: {
          taskId: "t-1",
          sessionId: "s-1",
          repo: "eskobar95/Optio-New",
          baseBranch: "development",
        },
      }),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      taskId: "t-1",
      sessionId: "s-1",
      jobId: "s-1__plan",
      queue: "optio.plan",
    });
    expect(added).toHaveLength(1);
    const plan = planJob(added[0] as FlowJob);
    expect(plan.queueName).toBe("optio.plan");
    expect(plan.opts?.jobId).toBe("s-1__plan");
    expect(plan.data).toEqual({
      taskId: "t-1",
      sessionId: "s-1",
      stage: "plan",
      title: "Add intake",
      description: "Enqueue the plan stage",
    });
  });

  it("rejects a malformed brief with a field error and does not enqueue", async () => {
    const added: FlowJob[] = [];
    const server = createIntakeServer({
      enqueuer: {
        async add(flow) {
          added.push(flow);
        },
      },
    });
    servers.push(server);
    const base = await listen(server);

    const response = await fetch(`${base}/intake`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ brief: { title: "" }, metadata: { taskId: "t-1" } }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: string;
      message: string;
      issues: { path: string; message: string }[];
    };
    expect(body.error).toBe("invalid_intake");
    expect(body.message).toBe("Intake payload is invalid");
    expect(body.issues).toContainEqual({
      path: "brief.title",
      message: "String must contain at least 1 character(s)",
    });
    expect(added).toHaveLength(0);
  });

  it("rejects JSON that is not an object and a task id that cannot be a BullMQ job id", async () => {
    const added: FlowJob[] = [];
    const server = createIntakeServer({
      enqueuer: {
        async add(flow) {
          added.push(flow);
        },
      },
    });
    servers.push(server);
    const base = await listen(server);

    const notJson = await fetch(`${base}/intake`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toEqual({
      error: "invalid_json",
      message: "Request body must be JSON",
    });

    const colonId = await fetch(`${base}/intake`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        brief: { title: "Add intake" },
        metadata: { taskId: "t:1" },
      }),
    });
    expect(colonId.status).toBe(400);
    const body = (await colonId.json()) as { issues: { path: string; message: string }[] };
    expect(body.issues).toContainEqual({
      path: "metadata.taskId",
      message: "must not contain ':'",
    });
    expect(added).toHaveLength(0);
  });

  it("uses the task id as the session id when metadata omits sessionId", async () => {
    const server = createIntakeServer({
      enqueuer: { async add() {} },
    });
    servers.push(server);
    const base = await listen(server);

    const response = await fetch(`${base}/intake`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        brief: { title: "Add intake" },
        metadata: { taskId: "t-2" },
      }),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      taskId: "t-2",
      sessionId: "t-2",
      jobId: "t-2__plan",
      queue: "optio.plan",
    });
  });

  it("reports redis on GET /health when a checker is provided", async () => {
    const up = createIntakeServer({
      enqueuer: { async add() {} },
      checkRedis: async () => true,
    });
    const down = createIntakeServer({
      enqueuer: { async add() {} },
      checkRedis: async () => false,
    });
    servers.push(up, down);

    const upResponse = await fetch(`${await listen(up)}/health`);
    expect(upResponse.status).toBe(200);
    expect(await upResponse.json()).toEqual({ ok: true, redis: "up" });

    const downResponse = await fetch(`${await listen(down)}/health`);
    expect(downResponse.status).toBe(503);
    expect(await downResponse.json()).toEqual({ ok: false, redis: "down" });
  });

  it("does not reference the Linear SDK", async () => {
    const source = await readFile(
      new URL("../src/orchestrator/intake/http.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/@linear|linear\.app|LinearClient|LINEAR_/);
  });
});
