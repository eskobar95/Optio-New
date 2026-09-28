import type { Server } from "node:http";
import { describe, expect, it } from "vitest";
import { createFlueServer, resolveFlueListen } from "../src/flue/server.js";

async function withServer(run: (base: string) => Promise<void>): Promise<void> {
  const server: Server = createFlueServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a TCP port");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe("flue stub HTTP", () => {
  it("resolveFlueListen falls back to 3220", () => {
    expect(resolveFlueListen({ FLUE_PORT: "nope" })).toEqual({ host: "0.0.0.0", port: 3220 });
    expect(resolveFlueListen({ FLUE_PORT: "3221", FLUE_HOST: "127.0.0.1" })).toEqual({
      host: "127.0.0.1",
      port: 3221,
    });
  });

  it("serves health, dispatch, and start", async () => {
    await withServer(async (base) => {
      const health = await fetch(`${base}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true, service: "flue" });

      const dispatch = await fetch(`${base}/dispatch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          taskId: "t-stub",
          worktreeId: "wt-1",
          workflowId: "default-task",
          stepId: "implementation",
          agentId: "agents/implementation",
          workspaceRef: "/tmp/wt",
          prompt: "stub",
        }),
      });
      expect(dispatch.status).toBe(200);
      const dispatched = (await dispatch.json()) as {
        sessionId: string;
        durableConversationId: string;
        status: string;
      };
      expect(dispatched.status).toBe("accepted");
      expect(dispatched.durableConversationId).toMatch(/^flue-conv-/);

      const start = await fetch(`${base}/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: dispatched.sessionId,
          durableConversationId: dispatched.durableConversationId,
          taskId: "t-stub",
        }),
      });
      expect(start.status).toBe(200);
      const started = (await start.json()) as {
        branch: string;
        status: string;
        usageEvents: unknown[];
      };
      expect(started).toMatchObject({
        branch: "flue/t-stub",
        status: "succeeded",
      });
      expect(started.usageEvents).toHaveLength(1);
    });
  });

  it("returns 404 for unknown session on start", async () => {
    await withServer(async (base) => {
      const start = await fetch(`${base}/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: "33333333-3333-4333-8333-333333333333",
          durableConversationId: "missing",
          taskId: "t-x",
        }),
      });
      expect(start.status).toBe(404);
    });
  });
});
