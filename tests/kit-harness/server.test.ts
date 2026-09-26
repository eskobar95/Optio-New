import type { Server } from "node:http";
import { describe, expect, it } from "vitest";
import { createKitHarnessServer, resolveListen } from "../../src/kit-harness/server.js";

async function withServer(
  options: Parameters<typeof createKitHarnessServer>[0],
  run: (base: string) => Promise<void>,
): Promise<void> {
  const server: Server = createKitHarnessServer(options);
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

async function post(
  base: string,
  path: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json: unknown = await response.json();
  if (!json || typeof json !== "object") throw new Error("expected json object");
  return { status: response.status, json: json as Record<string, unknown> };
}

describe("kit-harness HTTP", () => {
  it("resolveListen falls back to 3200", () => {
    expect(resolveListen({ KIT_HARNESS_PORT: "nope" })).toEqual({ host: "0.0.0.0", port: 3200 });
    expect(resolveListen({ KIT_HARNESS_PORT: "3201", KIT_HARNESS_HOST: "127.0.0.1" })).toEqual({
      host: "127.0.0.1",
      port: 3201,
    });
  });

  it("serves health and the five decision routes", async () => {
    await withServer({ env: {} }, async (base) => {
      const health = await fetch(`${base}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({
        ok: true,
        service: "kit-harness",
        engine: "rules",
        jev_configured: false,
      });

      const route = await post(base, "/v1/route-model", {
        coding_backend: "cursor",
        cursor_quota_remaining: 3,
      });
      expect(route.status).toBe(200);
      expect(route.json.choice).toBe("cursor_subscription");

      const gate = await post(base, "/v1/tool-gate", {
        tool: "shell",
        context: { command: "cat .env" },
      });
      expect(gate.json).toMatchObject({ decision: "deny", hard: true });

      const completion = await post(base, "/v1/completion-check", {
        tests_green: true,
        typecheck_green: true,
        lint_green: true,
      });
      expect(completion.json.verdict).toBe("pass");

      const loop = await post(base, "/v1/loop-detect", {
        events: [
          { fingerprint: "fp", tool: "run_tests", outcome: "fail" },
          { fingerprint: "fp", tool: "run_tests", outcome: "fail" },
          { fingerprint: "fp", tool: "run_tests", outcome: "fail" },
        ],
      });
      expect(loop.json).toMatchObject({ loop_detected: true, suggestion: "replan" });

      const split = await post(base, "/v1/split-or-proceed", { estimated_files: 12 });
      expect(split.json.action).toBe("split");
    });
  });

  it("reports jev_configured without changing the rules engine", async () => {
    await withServer({ env: { JEV_BASE_URL: "https://ai-gateway.vercel.sh" } }, async (base) => {
      const health = await fetch(`${base}/health`);
      expect(await health.json()).toMatchObject({ jev_configured: true, engine: "rules" });
      const route = await post(base, "/v1/route-model", { cursor_quota_remaining: 1 });
      expect(route.json).toMatchObject({ choice: "cursor_subscription", engine: "rules" });
    });
  });

  it("rejects unknown fields, bad JSON, unknown paths, and the wrong method", async () => {
    await withServer({ env: {} }, async (base) => {
      const extra = await post(base, "/v1/route-model", { coding_backend: "cursor", extra: true });
      expect(extra.status).toBe(400);
      expect(extra.json.error).toBe("invalid_request");

      const bad = await fetch(`${base}/v1/tool-gate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      });
      expect(bad.status).toBe(400);

      const missing = await fetch(`${base}/v1/nope`);
      expect(missing.status).toBe(404);

      const get = await fetch(`${base}/v1/loop-detect`);
      expect(get.status).toBe(405);
    });
  });

  it("rejects a body over the declared limit", async () => {
    await withServer({ env: {} }, async (base) => {
      const response = await fetch(`${base}/v1/split-or-proceed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ description: "x".repeat(70_000) }),
      });
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: "payload_too_large" });
    });
  });
});
