import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearToolAllowances,
  clearToolAudit,
  decideTool,
  detectLoop,
  readToolAudit,
} from "../../src/kit-harness/index.js";
import { createKitHarnessServer } from "../../src/kit-harness/server.js";
import type { DecisionAdvisor } from "../../src/kit-harness/types.js";

const FORBIDDEN_COMMAND = "rm -rf /tmp/optio-agent";

afterEach(() => {
  clearToolAudit();
  clearToolAllowances();
});

async function withServer(run: (base: string) => Promise<void>): Promise<void> {
  const server: Server = createKitHarnessServer({ env: {} });
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

async function post(base: string, path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  const json: unknown = await response.json();
  if (!json || typeof json !== "object") throw new Error("expected json object");
  return json as Record<string, unknown>;
}

describe("kit-harness smoke scenarios", () => {
  it("scenario 1 forbidden tool: rm -rf is denied and logged", async () => {
    const decision = await decideTool("shell", {
      command: FORBIDDEN_COMMAND,
      agent_id: "scenario-agent",
    });
    expect(decision).toMatchObject({
      decision: "deny",
      hard: true,
      reason: "hard_deny_destructive",
    });
    expect(readToolAudit()).toEqual([
      expect.objectContaining({
        tool: "shell",
        decision: "deny",
        command: FORBIDDEN_COMMAND,
      }),
    ]);

    clearToolAudit();
    await withServer(async (base) => {
      const gate = await post(base, "/v1/tool-gate", {
        tool: "shell",
        context: { command: FORBIDDEN_COMMAND, agent_id: "scenario-agent" },
      });
      expect(gate).toMatchObject({ decision: "deny", reason: "hard_deny_destructive", hard: true });
      const audit = (await (await fetch(`${base}/v1/audit`)).json()) as {
        entries: Array<Record<string, unknown>>;
      };
      expect(audit.entries).toEqual([
        expect.objectContaining({ tool: "shell", decision: "deny", command: FORBIDDEN_COMMAND }),
      ]);
    });
  });

  it("scenario 2 infinite loop: tool thrash halts", async () => {
    const events = [
      { fingerprint: "loop-1", tool: "shell", outcome: "fail" as const },
      { fingerprint: "loop-2", tool: "shell", outcome: "fail" as const },
      { fingerprint: "loop-3", tool: "shell", outcome: "fail" as const },
    ];
    expect(detectLoop({ events })).toMatchObject({
      loop_detected: true,
      halt: true,
      kind: "tool_thrash",
      suggestion: "stop",
      tool: "shell",
      reason: "tool_thrash_stop",
    });

    await withServer(async (base) => {
      const loop = await post(base, "/v1/loop-detect", { events });
      expect(loop).toMatchObject({
        loop_detected: true,
        halt: true,
        suggestion: "stop",
      });
    });
  });

  it("scenario 3 tool allowance: per-run budget denies the next call", async () => {
    const calls = { n: 0 };
    const advisor: DecisionAdvisor = {
      async advise() {
        calls.n += 1;
        return { choice: "allow", confidence: 1 };
      },
    };
    const context = {
      path: "README.md",
      run_id: "budget-run",
      max_tool_calls: 2,
      agent_id: "scenario-agent",
    };
    expect(await decideTool("read_file", context, advisor)).toMatchObject({
      decision: "allow",
      allowance: { used: 1, max: 2 },
    });
    expect(await decideTool("read_file", context, advisor)).toMatchObject({
      decision: "allow",
      allowance: { used: 2, max: 2 },
    });
    const blocked = await decideTool("read_file", context, advisor);
    expect(blocked).toMatchObject({
      decision: "deny",
      hard: true,
      reason: "tool_allowance_exceeded",
      engine: "rules",
      allowance: { run_id: "budget-run", used: 2, max: 2 },
    });
    expect(calls.n).toBe(2);
    expect(readToolAudit()).toEqual([
      expect.objectContaining({ reason: "tool_allowance_exceeded", decision: "deny" }),
    ]);

    clearToolAllowances();
    clearToolAudit();
    await withServer(async (base) => {
      const httpContext = {
        path: "README.md",
        run_id: "http-budget",
        max_tool_calls: 2,
        agent_id: "scenario-agent",
      };
      expect(
        await post(base, "/v1/tool-gate", { tool: "read_file", context: httpContext }),
      ).toMatchObject({
        decision: "allow",
      });
      expect(
        await post(base, "/v1/tool-gate", { tool: "read_file", context: httpContext }),
      ).toMatchObject({
        decision: "allow",
      });
      const third = await post(base, "/v1/tool-gate", { tool: "read_file", context: httpContext });
      expect(third).toMatchObject({
        decision: "deny",
        reason: "tool_allowance_exceeded",
        allowance: { used: 2, max: 2 },
      });
    });
  });
});
