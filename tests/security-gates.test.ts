import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createStubDecisionSidecar,
  runAgentLoop,
  type AuditSink,
  type DecisionSidecar,
  type ModelAdapter,
  type SkillLoader,
} from "../src/index.js";

const noSkills: SkillLoader = {
  async resolve() {
    return [];
  },
};

const FIXED_NOW = () => new Date("2026-09-26T00:00:00.000Z");

function auditSink(): AuditSink & { record: ReturnType<typeof vi.fn> } {
  return { record: vi.fn() };
}

function adapterReturning(
  toolCalls: NonNullable<Awaited<ReturnType<ModelAdapter["complete"]>>["toolCalls"]>,
): ModelAdapter {
  return {
    async complete(request) {
      return { text: `ack:${request.prompt}`, toolCalls };
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("hard security gates on the agent loop", () => {
  it("denies a .env read, audits it, and does not execute the tool", async () => {
    const audit = auditSink();
    const execute = vi.fn(async () => "secret-bytes");
    const sidecar: DecisionSidecar = {
      advise: vi.fn(async () => ({ verdict: "allow" as const, reason: "sidecar says allow" })),
    };

    const result = await runAgentLoop(
      {
        prompt: "read env",
        tools: {
          audit,
          execute,
          sidecar,
          now: FIXED_NOW,
          taskId: "t-1",
          stepId: "implementation",
          worktreeRoot: "/tmp/wt",
        },
      },
      adapterReturning([{ tool: "read_file", action: "read", path: ".env" }]),
      noSkills,
    );

    expect(result.text).toBe("ack:read env");
    expect(result.toolResults).toEqual([
      {
        status: "denied",
        decision: {
          verdict: "deny",
          gate: "secrets",
          reason: "secret path denied",
          audited: true,
        },
      },
    ]);
    expect(execute).not.toHaveBeenCalled();
    expect(sidecar.advise).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith({
      at: "2026-09-26T00:00:00.000Z",
      taskId: "t-1",
      stepId: "implementation",
      gate: "secrets",
      verdict: "deny",
      action: "read",
      tool: "read_file",
      path: ".env",
      reason: "secret path denied",
    });
  });

  it("denies key paths and secret commands without recording secret material", async () => {
    const audit = auditSink();
    const execute = vi.fn(async () => "nope");
    const command = "cat certs/server.pem # SUPERSECRETVALUE";

    const result = await runAgentLoop(
      {
        prompt: "keys",
        tools: { audit, execute, now: FIXED_NOW, worktreeRoot: "/tmp/wt" },
      },
      adapterReturning([
        { tool: "read_file", action: "read", path: "/tmp/wt/id_rsa" },
        { tool: "read_file", action: "read", path: "secrets/.env" },
        { tool: "shell", action: "exec", command },
      ]),
      noSkills,
    );

    expect(result.toolResults?.map((entry) => entry.decision.reason)).toEqual([
      "secret path denied",
      "secret path denied",
      "secret path denied",
    ]);
    expect(execute).not.toHaveBeenCalled();
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain("SUPERSECRETVALUE");
    expect(audit.record).toHaveBeenCalledTimes(3);
  });

  it("allows reading .env.example and secrets/README.md", async () => {
    const audit = auditSink();
    const execute = vi.fn(async () => "example");

    const result = await runAgentLoop(
      {
        prompt: "examples",
        tools: { audit, execute, worktreeRoot: "/tmp/wt" },
      },
      adapterReturning([
        { tool: "read_file", action: "read", path: ".env.example" },
        { tool: "read_file", action: "read", path: "secrets/README.md" },
      ]),
      noSkills,
    );

    expect(result.toolResults).toEqual([
      {
        status: "allowed",
        value: "example",
        decision: {
          verdict: "allow",
          gate: "none",
          reason: "hard gates passed",
          audited: false,
        },
      },
      {
        status: "allowed",
        value: "example",
        decision: {
          verdict: "allow",
          gate: "none",
          reason: "hard gates passed",
          audited: false,
        },
      },
    ]);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("denies writes to AGENTS.md and harness config, and still allows reading them", async () => {
    const audit = auditSink();
    const execute = vi.fn(async () => "contents");

    const result = await runAgentLoop(
      {
        prompt: "mutate config",
        tools: { audit, execute, now: FIXED_NOW, worktreeRoot: "/tmp/wt" },
      },
      adapterReturning([
        { tool: "edit_file", action: "write", path: "AGENTS.md" },
        { tool: "edit_file", action: "write", path: "/tmp/wt/harness.config.yaml" },
        { tool: "edit_file", action: "write", path: "workflows/default-task.yaml" },
        { tool: "edit_file", action: "write", path: ".cursor/skills/bot-session/SKILL.md" },
        { tool: "read_file", action: "read", path: "AGENTS.md" },
      ]),
      noSkills,
    );

    expect(result.toolResults?.slice(0, 4).map((entry) => entry.status)).toEqual([
      "denied",
      "denied",
      "denied",
      "denied",
    ]);
    expect(
      result.toolResults?.slice(0, 4).every((entry) => entry.decision.gate === "config_lock"),
    ).toBe(true);
    expect(result.toolResults?.[0]?.decision.reason).toBe("harness config write denied");
    expect(result.toolResults?.[4]).toMatchObject({ status: "allowed", value: "contents" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        gate: "config_lock",
        path: "AGENTS.md",
        action: "write",
        reason: "harness config write denied",
      }),
    );
  });

  it("denies a shell redirect that writes AGENTS.md", async () => {
    const audit = auditSink();
    const execute = vi.fn(async () => "mutated");

    const result = await runAgentLoop(
      {
        prompt: "hijack",
        tools: { audit, execute, now: FIXED_NOW, worktreeRoot: "/tmp/wt" },
      },
      adapterReturning([
        { tool: "shell", action: "exec", command: "printf '# hijack\n' > AGENTS.md" },
      ]),
      noSkills,
    );

    expect(result.toolResults).toEqual([
      {
        status: "denied",
        decision: {
          verdict: "deny",
          gate: "config_lock",
          reason: "harness config write denied",
          audited: true,
        },
      },
    ]);
    expect(execute).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        gate: "config_lock",
        path: "AGENTS.md",
        action: "exec",
        reason: "harness config write denied",
      }),
    );
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain("# hijack");
  });

  it("cancels a hung tool when the timeout elapses", async () => {
    vi.useFakeTimers();
    const audit = auditSink();
    let signal: AbortSignal | undefined;
    const execute = vi.fn(
      (_call: unknown, abortSignal: AbortSignal) =>
        new Promise<string>(() => {
          signal = abortSignal;
        }),
    );

    const pending = runAgentLoop(
      {
        prompt: "hang",
        tools: { audit, execute, now: FIXED_NOW, taskId: "t-9" },
      },
      adapterReturning([{ tool: "shell", action: "exec", command: "sleep 999" }]),
      noSkills,
    );

    await vi.advanceTimersByTimeAsync(30_000);
    const result = await pending;

    expect(signal?.aborted).toBe(true);
    expect(result.toolResults).toEqual([
      {
        status: "cancelled",
        decision: {
          verdict: "deny",
          gate: "tool_timeout",
          reason: "tool timed out after 30000ms and was cancelled",
          audited: true,
        },
      },
    ]);
    expect(audit.record).toHaveBeenCalledWith({
      at: "2026-09-26T00:00:00.000Z",
      taskId: "t-9",
      gate: "tool_timeout",
      verdict: "deny",
      action: "exec",
      tool: "shell",
      reason: "tool timed out after 30000ms and was cancelled",
    });
  });

  it("propagates a tool failure that is not a timeout", async () => {
    const audit = auditSink();
    const execute = vi.fn(async () => {
      throw new Error("disk full");
    });

    await expect(
      runAgentLoop(
        {
          prompt: "edit",
          tools: { audit, execute, timeoutMs: 30_000 },
        },
        adapterReturning([{ tool: "edit_file", action: "write", path: "src/index.ts" }]),
        noSkills,
      ),
    ).rejects.toThrow("disk full");
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("lets a denying sidecar block a normal read without overriding a hard deny", async () => {
    const audit = auditSink();
    const execute = vi.fn(async () => "body");
    const sidecar: DecisionSidecar = {
      advise: vi.fn(async () => ({ verdict: "deny" as const, reason: "needs human" })),
    };

    const deniedBySidecar = await runAgentLoop(
      {
        prompt: "read source",
        tools: { audit, execute, sidecar, now: FIXED_NOW },
      },
      adapterReturning([{ tool: "read_file", action: "read", path: "src/index.ts" }]),
      noSkills,
    );

    expect(deniedBySidecar.toolResults).toEqual([
      {
        status: "denied",
        decision: {
          verdict: "deny",
          gate: "sidecar",
          reason: "needs human",
          audited: true,
        },
      },
    ]);
    expect(execute).not.toHaveBeenCalled();

    const stub = createStubDecisionSidecar();
    const allowed = await runAgentLoop(
      {
        prompt: "read source",
        tools: { audit, execute, sidecar: stub },
      },
      adapterReturning([{ tool: "read_file", action: "read", path: "src/index.ts" }]),
      noSkills,
    );
    expect(allowed.toolResults?.[0]).toMatchObject({ status: "allowed", value: "body" });
  });

  it("denies a path that escapes the worktree", async () => {
    const audit = auditSink();
    const execute = vi.fn(async () => "outside");

    const result = await runAgentLoop(
      {
        prompt: "escape",
        tools: { audit, execute, now: FIXED_NOW, worktreeRoot: "/tmp/wt" },
      },
      adapterReturning([{ tool: "read_file", action: "read", path: "../etc/passwd" }]),
      noSkills,
    );

    expect(result.toolResults?.[0]?.decision).toEqual({
      verdict: "deny",
      gate: "secrets",
      reason: "path escapes the worktree",
      audited: true,
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
