import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { createLayaRouter } from "../src/index.js";

const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    child.kill("SIGTERM");
  }
});

function layaBlock(): string {
  const compose = readFileSync("docker-compose.yml", "utf8");
  const start = compose.indexOf("\n  # Optional local Laya");
  const end = compose.indexOf("\n  otel-collector:\n");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return compose.slice(start, end);
}

describe("laya compose profile", () => {
  it("stays off the default, full, and harness profiles and pins CPU", () => {
    const compose = readFileSync("docker-compose.yml", "utf8");
    const block = layaBlock();
    expect(block).toContain('profiles: ["laya"]');
    expect(block).toContain("image: python:3.12-slim");
    expect(block).toContain("./deploy/laya/stub_server.py:/app/stub_server.py:ro");
    expect(block).toContain("LAYA_DEVICE: cpu");
    expect(block).not.toContain("${LAYA_DEVICE");
    expect(block).toContain("127.0.0.1:${OPTIO_NEW_LAYA_HOST_PORT:-8000}:8000");
    expect(block).toContain("http://127.0.0.1:8000/health");
    expect(block).toContain("NVIDIA Container Toolkit is not required");
    expect(block).not.toContain("laya[serve]");
    expect(block).not.toMatch(/gpus:|capabilities:\s*\[gpu\]|runtime:\s*nvidia|driver:\s*nvidia/);

    const harness = compose.slice(
      compose.indexOf("\n  kit-harness:\n"),
      compose.indexOf("\n  # Optional local Laya"),
    );
    expect(harness).toContain('profiles: ["harness"]');
    expect(compose).toContain('profiles: ["full", "orchestrator"]');
    expect(compose).toContain('profiles: ["full"]');
  });

  it("documents that the profile is off and that NVIDIA is not required", () => {
    const doc = readFileSync("docs/laya.md", "utf8");
    expect(doc).toContain("off by default");
    expect(doc).toContain("--profile laya");
    expect(doc).toContain("GET /health");
    expect(doc).toContain("NVIDIA Container Toolkit");
    expect(doc).toContain("OPTIO_NEW_LAYA_URL");
    expect(doc).toContain("LAYA_API_KEY");
    expect(doc).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
  });
});

function startStub(extra: Record<string, string> = {}): Promise<{ port: number }> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  Object.assign(env, {
    LAYA_HOST: "127.0.0.1",
    LAYA_PORT: "0",
    LAYA_DEVICE: "cpu",
    LAYA_API_KEY: "",
    ...extra,
  });
  const child = spawn("python3", ["-B", "deploy/laya/stub_server.py"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  child.stderr?.resume();

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error("laya placeholder did not listen"));
    }, 5000);
    const lines = createInterface({ input: child.stdout! });
    lines.on("line", (line) => {
      if (settled) return;
      const message = JSON.parse(line) as { event?: string; port?: number };
      if (message.event === "listen" && typeof message.port === "number") {
        settled = true;
        clearTimeout(timer);
        lines.close();
        resolve({ port: message.port });
      }
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`laya placeholder exited ${String(code)}`));
    });
  });
}

describe("laya placeholder", () => {
  it("answers /health on CPU and lets the laya plugin target /v1/systemone", async () => {
    const { port } = await startStub();
    const base = `http://127.0.0.1:${port}`;
    const health = (await fetch(`${base}/health`).then((response) => response.json())) as {
      status: string;
      device: string;
      engine: string;
      nvidia_required: boolean;
    };
    expect(health).toMatchObject({
      status: "ok",
      device: "cpu",
      engine: "placeholder",
      nvidia_required: false,
    });
    expect(await fetch(`${base}/healthz`).then((response) => response.status)).toBe(200);

    const router = createLayaRouter({
      env: { OPTIO_NEW_LAYA_URL: base },
    });
    await expect(router.decide({ task_id: "t-laya", prompt_hash: "h" })).resolves.toEqual({
      choice: "deny",
      reason: "systemone",
      confidence: 0,
    });
  });

  it("requires the bearer token only when LAYA_API_KEY is set", async () => {
    const { port } = await startStub({ LAYA_API_KEY: "test-key" });
    const base = `http://127.0.0.1:${port}`;
    const open = await fetch(`${base}/health`);
    expect(open.status).toBe(200);

    const missing = createLayaRouter({ env: { OPTIO_NEW_LAYA_URL: base, LAYA_API_KEY: "" } });
    await expect(missing.decide({})).resolves.toEqual({
      choice: "deny",
      reason: "upstream_http",
    });

    const authed = createLayaRouter({
      env: { OPTIO_NEW_LAYA_URL: base, OPTIO_NEW_LAYA_API_KEY: "test-key" },
    });
    await expect(authed.decide({})).resolves.toEqual({
      choice: "deny",
      reason: "systemone",
      confidence: 0,
    });
  });
});
