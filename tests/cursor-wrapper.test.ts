import { describe, expect, it } from "vitest";

import type { CodingAgentInput } from "../src/adapters/coding-agent.js";
import { createCursorAdapter } from "../src/adapters/cursor/index.js";
import { CURSOR_IMPLEMENT_ACI_POLICY } from "../src/adapters/cursor/implement-feedback.js";
import {
  applyCompaction,
  appendPickToPrompt,
  compactCliStdout,
  formatPickHint,
  parseTranscriptTurns,
  passthroughDecision,
  prepareCursorInvoke,
  resolveWrapperPorts,
  type DecisionPort,
  type SkillMcpPickPort,
  type TranscriptTurn,
  type WardenPort,
} from "../src/adapters/cursor/wrapper.js";
import type { CliRunRequest, CliRunResult } from "../src/adapters/runtime.js";

const PROMPT = "implement the seam";
const INSTRUCTIONS = "follow the spec";
const EXPECTED_PROMPT = `${INSTRUCTIONS}\n\n${PROMPT}`;
const CURSOR_IMPLEMENT_PROMPT = `${EXPECTED_PROMPT}\n\n${CURSOR_IMPLEMENT_ACI_POLICY}`;
const CURSOR_KEY = "cursor-key-secret";

function sampleInput(overrides: Partial<CodingAgentInput> = {}): CodingAgentInput {
  return {
    worktree_path: "/tmp/wt-task",
    prompt: PROMPT,
    instructions: INSTRUCTIONS,
    allowed_tools: ["edit", "shell"],
    budget: { maxWallClockMs: 1000 },
    metadata: {
      task_id: "t-21",
      worktree_id: "wt-21",
      workflow_id: "default-task",
      step_id: "implementation",
      agent_id: "agents/implementation",
      model_id: "gpt-4o",
    },
    ...overrides,
  };
}

function fakeRunner(result: Partial<CliRunResult> = {}) {
  const calls: CliRunRequest[] = [];
  return {
    calls,
    runner: async (request: CliRunRequest): Promise<CliRunResult> => {
      calls.push(request);
      return {
        exitCode: result.exitCode ?? 0,
        stdout:
          result.stdout ??
          JSON.stringify({
            type: "result",
            subtype: "success",
            is_error: false,
            result: "ok",
          }),
        stderr: result.stderr ?? "",
        timedOut: result.timedOut ?? false,
        signal: result.signal ?? null,
      };
    },
  };
}

describe("applyCompaction", () => {
  it("truncates oversized tool payloads and leaves user/assistant text unchanged", () => {
    const longTool = "x".repeat(5_000);
    const turns: TranscriptTurn[] = [
      { role: "user", content: "please fix the bug" },
      { role: "assistant", content: "I will run a search" },
      { role: "tool", name: "shell", content: longTool },
      { role: "assistant", content: "done" },
    ];

    const compacted = applyCompaction(turns, 100);

    expect(compacted[0]).toEqual(turns[0]);
    expect(compacted[1]).toEqual(turns[1]);
    expect(compacted[3]).toEqual(turns[3]);
    expect(compacted[2]?.content.startsWith("x".repeat(100))).toBe(true);
    expect(compacted[2]?.content).toContain("…[truncated 4900 chars]");
    expect(compacted[2]?.content.length).toBeLessThan(longTool.length);
  });

  it("is a no-op when tool payloads are under the limit", () => {
    const turns: TranscriptTurn[] = [{ role: "tool", name: "shell", content: "short" }];
    expect(applyCompaction(turns, 100)).toEqual([
      { role: "tool", name: "shell", content: "short" },
    ]);
  });
});

describe("compactCliStdout", () => {
  it("leaves normal Cursor result JSON unchanged (no turns)", async () => {
    const stdout = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "ok",
    });
    const ports = resolveWrapperPorts();
    expect(await compactCliStdout(ports, stdout)).toBe(stdout);
    expect(parseTranscriptTurns(stdout)).toBeNull();
  });

  it("compacts oversized tool turns embedded in stdout JSON", async () => {
    const longTool = "z".repeat(500);
    const stdout = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "ok",
      turns: [
        { role: "user", content: "go" },
        { role: "tool", name: "shell", content: longTool },
        { role: "assistant", content: "done" },
      ],
    });
    const ports = resolveWrapperPorts({}, { toolResultMaxChars: 50 });
    const next = await compactCliStdout(ports, stdout);
    const turns = parseTranscriptTurns(next);
    expect(turns?.[0]).toEqual({ role: "user", content: "go" });
    expect(turns?.[2]).toEqual({ role: "assistant", content: "done" });
    expect(turns?.[1]?.content.startsWith("z".repeat(50))).toBe(true);
    expect(turns?.[1]?.content).toContain("…[truncated 450 chars]");
  });

  it("honors DecisionPort compact maxChars", async () => {
    const stdout = JSON.stringify({
      type: "result",
      turns: [{ role: "tool", content: "abcdefghij" }],
    });
    const decision: DecisionPort = {
      async decide(request) {
        if (request.kind === "compact") return { type: "compact", maxChars: 4 };
        return { type: "passthrough" };
      },
    };
    const next = await compactCliStdout(resolveWrapperPorts({ decision }), stdout);
    expect(parseTranscriptTurns(next)?.[0]?.content).toMatch(/^abcd\n…\[truncated 6 chars\]$/);
  });
});

describe("skill/MCP pick", () => {
  it("leaves the prompt unchanged when pick is empty", () => {
    expect(formatPickHint({ skills: [], mcpServers: [] })).toBeNull();
    expect(appendPickToPrompt(EXPECTED_PROMPT, { skills: [], mcpServers: [] })).toBe(
      EXPECTED_PROMPT,
    );
  });

  it("appends a pick hint when skills or mcp servers are present", () => {
    const withSkills = appendPickToPrompt(EXPECTED_PROMPT, {
      skills: ["bot-session"],
      mcpServers: [],
    });
    expect(withSkills).toContain(EXPECTED_PROMPT);
    expect(withSkills).toContain("[optio-wrapper pick]");
    expect(withSkills).toContain("skills: bot-session");

    const withMcp = appendPickToPrompt(EXPECTED_PROMPT, {
      skills: [],
      mcpServers: ["jev"],
    });
    expect(withMcp).toContain("mcp: jev");
  });
});

describe("prepareCursorInvoke", () => {
  it("denies when warden blocks a mutation tool", async () => {
    const warden: WardenPort = {
      gate: () => ({ allow: false, reason: "shell blocked in stub" }),
    };
    const prepared = await prepareCursorInvoke({
      prompt: EXPECTED_PROMPT,
      allowedTools: ["shell"],
      stepId: "implementation",
      ports: resolveWrapperPorts({ warden }),
    });
    expect(prepared.ok).toBe(false);
    if (prepared.ok) throw new Error("expected deny");
    expect(prepared.observation).toMatch(/Permission denied by wrapper warden/);
    expect(prepared.observation).toMatch(/shell blocked/);
  });

  it("batches one DecisionPort warden call for all mutation tools", async () => {
    let wardenCalls = 0;
    const decision: DecisionPort = {
      async decide(request) {
        if (request.kind === "warden") {
          wardenCalls += 1;
          expect(request.payload).toEqual({ tools: ["edit", "shell"] });
          return { type: "warden", decision: { allow: true, reason: "batch ok" } };
        }
        return { type: "passthrough" };
      },
    };
    const warden: WardenPort = {
      gate: () => {
        throw new Error("local warden should not run when DecisionPort returns warden");
      },
    };
    const prepared = await prepareCursorInvoke({
      prompt: EXPECTED_PROMPT,
      allowedTools: ["edit", "shell", "read"],
      stepId: "implementation",
      ports: resolveWrapperPorts({ decision, warden }),
    });
    expect(prepared.ok).toBe(true);
    expect(wardenCalls).toBe(1);
  });

  it("passthrough DecisionPort timeout leaves pick and warden defaults", async () => {
    const slowDecision: DecisionPort = {
      decide: () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ type: "passthrough" }), 200);
        }),
    };
    const prepared = await prepareCursorInvoke({
      prompt: EXPECTED_PROMPT,
      allowedTools: ["edit"],
      stepId: "implementation",
      ports: resolveWrapperPorts({ decision: slowDecision }),
      decisionTimeoutMs: 20,
    });
    expect(prepared).toEqual({
      ok: true,
      prompt: EXPECTED_PROMPT,
      pick: { skills: [], mcpServers: [] },
    });
  });

  it("DecisionPort reject degrades to passthrough", async () => {
    const failing: DecisionPort = {
      async decide() {
        throw new Error("jev down");
      },
    };
    const prepared = await prepareCursorInvoke({
      prompt: EXPECTED_PROMPT,
      allowedTools: ["read"],
      stepId: "implementation",
      ports: resolveWrapperPorts({ decision: failing }),
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error("expected ok");
    expect(prepared.prompt).toBe(EXPECTED_PROMPT);
  });
});

describe("createCursorAdapter wrapper wiring", () => {
  it("returns permission_denied and does not spawn when warden denies", async () => {
    const { runner, calls } = fakeRunner();
    const warden: WardenPort = {
      gate: () => ({ allow: false, reason: "edit denied" }),
    };
    const agent = createCursorAdapter({
      runner,
      env: { CURSOR_API_KEY: CURSOR_KEY, PATH: "/usr/bin" },
      wrapper: { warden },
    });

    const output = await agent.run(sampleInput());

    expect(calls).toHaveLength(0);
    expect(output).toMatchObject({
      status: "failed",
      error_class: "permission_denied",
      pr_ready: false,
    });
    expect(output.observation).toMatch(/Permission denied by wrapper warden/);
    expect(output.logs).toBe(output.observation);
  });

  it("leaves the CLI prompt unchanged when pick is empty (happy path)", async () => {
    const { runner, calls } = fakeRunner();
    const agent = createCursorAdapter({
      runner,
      env: { CURSOR_API_KEY: CURSOR_KEY, PATH: "/usr/bin" },
      wrapper: { decision: passthroughDecision() },
    });

    const output = await agent.run(sampleInput());

    expect(output.status).toBe("succeeded");
    expect(calls).toHaveLength(1);
    const promptArg = calls[0]?.args.at(-1);
    expect(promptArg).toBe(CURSOR_IMPLEMENT_PROMPT);
  });

  it("injects pick hint into the prompt arg before spawn", async () => {
    const { runner, calls } = fakeRunner();
    const pick: SkillMcpPickPort = {
      pick: () => ({ skills: ["tdd"], mcpServers: ["filesystem"] }),
    };
    const agent = createCursorAdapter({
      runner,
      env: { CURSOR_API_KEY: CURSOR_KEY, PATH: "/usr/bin" },
      wrapper: { pick },
    });

    await agent.run(sampleInput());

    const promptArg = calls[0]?.args.at(-1) ?? "";
    expect(promptArg.startsWith(CURSOR_IMPLEMENT_PROMPT)).toBe(true);
    expect(promptArg).toContain("skills: tdd");
    expect(promptArg).toContain("mcp: filesystem");
  });

  it("uses DecisionPort warden outcome when provided before timeout", async () => {
    const { runner, calls } = fakeRunner();
    const decision: DecisionPort = {
      async decide(request) {
        if (request.kind === "warden") {
          return {
            type: "warden",
            decision: { allow: false, reason: "jev deny" },
          };
        }
        return { type: "passthrough" };
      },
    };
    const agent = createCursorAdapter({
      runner,
      env: { CURSOR_API_KEY: CURSOR_KEY, PATH: "/usr/bin" },
      wrapper: { decision },
    });

    const output = await agent.run(sampleInput({ allowed_tools: ["shell"] }));

    expect(calls).toHaveLength(0);
    expect(output.error_class).toBe("permission_denied");
    expect(output.observation).toMatch(/jev deny/);
  });

  it("compacts tool turns in CLI stdout after spawn", async () => {
    const longTool = "q".repeat(200);
    const { runner } = fakeRunner({
      stdout: JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "edited",
        turns: [
          { role: "user", content: "fix" },
          { role: "tool", name: "shell", content: longTool },
        ],
      }),
    });
    const agent = createCursorAdapter({
      runner,
      env: { CURSOR_API_KEY: CURSOR_KEY, PATH: "/usr/bin" },
      wrapper: {
        compaction: {
          compact: (turns) => applyCompaction(turns, 40),
        },
      },
    });

    const output = await agent.run(sampleInput({ allowed_tools: ["read"] }));
    expect(output.status).toBe("succeeded");
  });
});
