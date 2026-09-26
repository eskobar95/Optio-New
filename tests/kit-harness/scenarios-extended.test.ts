import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearToolAudit,
  decideTool,
  invokeGuardedTool,
  readToolAudit,
  runIsolationProbe,
  runStubbedFlow,
} from "../../src/kit-harness/index.js";
import { createKitHarnessServer } from "../../src/kit-harness/server.js";
import type { DecisionAdvisor } from "../../src/kit-harness/types.js";

afterEach(() => {
  clearToolAudit();
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
  it("scenario 4 secret read: .env is denied and logged", async () => {
    const envRead = await decideTool("read_file", { path: ".env", agent_id: "scenario-agent" });
    const keyRead = await decideTool("read_file", { path: "config/api-keys.json" });
    expect(envRead).toMatchObject({ decision: "deny", hard: true, reason: "hard_deny_secret" });
    expect(keyRead).toMatchObject({ decision: "deny", hard: true, reason: "hard_deny_secret" });
    expect(readToolAudit().map((entry) => entry.command ?? entry.reason)).toEqual([
      "hard_deny_secret",
      "hard_deny_secret",
    ]);
    expect(readToolAudit()[0]).toMatchObject({ tool: "read_file", decision: "deny" });

    clearToolAudit();
    await withServer(async (base) => {
      const gate = await post(base, "/v1/tool-gate", {
        tool: "read_file",
        context: { path: ".env", agent_id: "scenario-agent" },
      });
      expect(gate).toMatchObject({ decision: "deny", reason: "hard_deny_secret", hard: true });
      const audit = (await (await fetch(`${base}/v1/audit`)).json()) as {
        entries: Array<Record<string, unknown>>;
      };
      expect(audit.entries).toEqual([
        expect.objectContaining({
          tool: "read_file",
          decision: "deny",
          reason: "hard_deny_secret",
        }),
      ]);
    });
  });

  it("scenario 5 self-config mutation: AGENTS.md write is denied", async () => {
    const calls = { n: 0 };
    const advisor: DecisionAdvisor = {
      async advise() {
        calls.n += 1;
        return { choice: "allow", confidence: 1 };
      },
    };
    const write = await decideTool("edit_file", { path: "AGENTS.md" }, advisor);
    const shell = await decideTool("shell", { command: "printf x >> AGENTS.md" });
    const read = await decideTool("read_file", { path: "AGENTS.md" });
    expect(write).toMatchObject({ decision: "deny", hard: true, reason: "self_config_mutation" });
    expect(shell).toMatchObject({ decision: "deny", reason: "self_config_mutation" });
    expect(read).toMatchObject({ decision: "allow" });
    expect(calls.n).toBe(0);

    await withServer(async (base) => {
      const gate = await post(base, "/v1/tool-gate", {
        tool: "write_file",
        context: { path: "src/kit-harness/tool-gate.ts" },
      });
      expect(gate).toMatchObject({ decision: "deny", reason: "self_config_mutation", hard: true });
    });
  });

  it("scenario 6 hung tool: timeout cancels the call", async () => {
    const started = Date.now();
    const result = await invokeGuardedTool({
      tool: "read_file",
      context: { path: "src/app.ts" },
      timeout_ms: 20,
      run: () => new Promise(() => undefined),
    });
    expect(Date.now() - started).toBeLessThan(500);
    expect(result).toEqual({ status: "cancel", reason: "tool_timeout", tool: "read_file" });

    const quick = await invokeGuardedTool({
      tool: "read_file",
      context: { path: "src/app.ts" },
      timeout_ms: 200,
      run: async () => ({ ok: true }),
    });
    expect(quick).toEqual({ status: "ok", reason: "completed", tool: "read_file" });

    await withServer(async (base) => {
      const gate = await post(base, "/v1/tool-invoke", {
        tool: "read_file",
        timeout_ms: 30,
        mode: "hang",
        context: { path: "src/app.ts" },
      });
      expect(gate).toEqual({ status: "cancel", reason: "tool_timeout", tool: "read_file" });
    });
  });

  it("scenario 7 end-to-end flow: intake to pull request", async () => {
    const flow = await runStubbedFlow({ task_id: "t-smoke", title: "stub a change" });
    expect(flow).toEqual({
      ok: true,
      stages: ["intake", "worktree", "implementation", "review", "pr"],
      task_id: "t-smoke",
      worktree_path: "/optio/worktrees/t-smoke",
      pr: { branch: "task/t-smoke", ready: true },
    });

    await withServer(async (base) => {
      const httpFlow = await post(base, "/v1/flow", { task_id: "t-http", title: "http stub" });
      expect(httpFlow).toMatchObject({
        ok: true,
        stages: ["intake", "worktree", "implementation", "review", "pr"],
        worktree_path: "/optio/worktrees/t-http",
        pr: { branch: "task/t-http", ready: true },
      });
    });
  });

  it("scenario 8 worktree isolation: agents cannot cross-write", async () => {
    const probe = runIsolationProbe();
    expect(probe.isolated).toBe(true);
    expect(probe.reason).toBe("separate_paths");
    expect(probe.agent_a).toEqual({ "note.txt": "alpha" });
    expect(probe.agent_b).toEqual({ "note.txt": "beta" });

    await withServer(async (base) => {
      const httpProbe = await post(base, "/v1/worktree-isolation", {});
      expect(httpProbe).toMatchObject({
        isolated: true,
        reason: "separate_paths",
        agent_a: { "note.txt": "alpha" },
        agent_b: { "note.txt": "beta" },
      });
    });
  });
});
