import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { FlowJob } from "bullmq";
import { afterEach, describe, expect, it } from "vitest";
import { createIntakeServer } from "../src/index.js";
import { signIntakeWebhookBody } from "../src/orchestrator/intake/webhook-auth.js";

const SECRET = "test-intake-webhook-secret";

const PAYLOAD = {
  brief: { title: "Add intake", description: "via the edge" },
  metadata: { taskId: "t-edge", sessionId: "s-edge" },
};

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

describe("POST /webhooks/intake", () => {
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

  function start(webhookSecret: string | undefined) {
    const added: FlowJob[] = [];
    const server = createIntakeServer({
      webhookSecret,
      enqueuer: {
        async add(flow) {
          added.push(flow);
        },
      },
    });
    servers.push(server);
    return { added, server };
  }

  it("enqueues when the HMAC matches the raw body", async () => {
    const { added, server } = start(SECRET);
    const base = await listen(server);
    const body = JSON.stringify(PAYLOAD);
    const response = await fetch(`${base}/webhooks/intake`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-optio-signature": signIntakeWebhookBody(SECRET, Buffer.from(body)),
      },
      body,
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      taskId: "t-edge",
      sessionId: "s-edge",
      jobId: "s-edge__plan",
      queue: "optio.plan",
      repoId: "default",
    });
    expect(added).toHaveLength(1);
  });

  it("does not enqueue when the signature is missing or wrong", async () => {
    const { added, server } = start(SECRET);
    const base = await listen(server);
    const body = JSON.stringify(PAYLOAD);

    const missing = await fetch(`${base}/webhooks/intake`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({
      error: "invalid_signature",
      message: "Intake webhook signature is invalid",
    });

    const wrong = await fetch(`${base}/webhooks/intake`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-optio-signature": signIntakeWebhookBody("other-secret", Buffer.from(body)),
      },
      body,
    });
    expect(wrong.status).toBe(401);
    expect(added).toHaveLength(0);
  });

  it("fails closed when the webhook secret is blank", async () => {
    const { added, server } = start("  ");
    const base = await listen(server);
    const body = JSON.stringify(PAYLOAD);
    const response = await fetch(`${base}/webhooks/intake`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-optio-signature": signIntakeWebhookBody(SECRET, Buffer.from(body)),
      },
      body,
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "webhook_auth_unconfigured",
      message: "Intake webhook secret is not configured",
    });
    expect(added).toHaveLength(0);
  });

  it("keeps loopback POST /intake open when a webhook secret is set", async () => {
    const { added, server } = start(SECRET);
    const base = await listen(server);
    const response = await fetch(`${base}/intake`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(PAYLOAD),
    });

    expect(response.status).toBe(202);
    expect(added).toHaveLength(1);
  });
});
