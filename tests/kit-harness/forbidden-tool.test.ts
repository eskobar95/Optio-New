import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearToolAudit, decideTool, readToolAudit } from "../../src/kit-harness/index.js";
import { createKitHarnessServer } from "../../src/kit-harness/server.js";

const FORBIDDEN_COMMAND = "rm -rf /tmp/optio-agent";

afterEach(() => {
  clearToolAudit();
  vi.restoreAllMocks();
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

describe("forbidden tool scenario", () => {
  it("blocks shell rm -rf and records a structured deny", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
      lines.push(String(line));
    });

    const decision = await decideTool("shell", {
      command: FORBIDDEN_COMMAND,
      agent_id: "scenario-agent",
    });

    expect(decision).toMatchObject({
      decision: "deny",
      hard: true,
      reason: "hard_deny_destructive",
      engine: "rules",
    });

    expect(readToolAudit()).toEqual([
      expect.objectContaining({
        tool: "shell",
        decision: "deny",
        reason: "hard_deny_destructive",
        hard: true,
        command: FORBIDDEN_COMMAND,
        agent_id: "scenario-agent",
      }),
    ]);

    const logged = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(logged).toContainEqual(
      expect.objectContaining({
        service: "kit-harness",
        event: "tool_denied",
        tool: "shell",
        decision: "deny",
        reason: "hard_deny_destructive",
        hard: true,
        command: FORBIDDEN_COMMAND,
        agent_id: "scenario-agent",
      }),
    );
  });

  it("blocks shell rm -rf over HTTP and exposes the audit trail", async () => {
    await withServer(async (base) => {
      const response = await fetch(`${base}/v1/tool-gate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tool: "shell",
          context: { command: FORBIDDEN_COMMAND, agent_id: "scenario-agent" },
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        decision: "deny",
        hard: true,
        reason: "hard_deny_destructive",
      });

      const audit = await fetch(`${base}/v1/audit`);
      expect(audit.status).toBe(200);
      const body = (await audit.json()) as { entries: Array<Record<string, unknown>> };
      expect(body.entries).toEqual([
        expect.objectContaining({
          tool: "shell",
          decision: "deny",
          command: FORBIDDEN_COMMAND,
          agent_id: "scenario-agent",
        }),
      ]);
    });
  });
});
