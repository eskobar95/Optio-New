import { describe, expect, it } from "vitest";

import type { CodingAgentInput } from "../src/adapters/coding-agent.js";
import {
  createOptioRunAdapter,
  hasJevKey,
  type OptioRunInput,
  type OptioRunResult,
} from "../src/adapters/optio-run/index.js";
import { createCodingAgent, isCodingBackendId } from "../src/adapters/select.js";

function sampleInput(overrides: Partial<CodingAgentInput> = {}): CodingAgentInput {
  return {
    worktree_path: "/tmp/wt-task",
    prompt: "implement the seam",
    instructions: "follow the spec",
    allowed_tools: ["edit", "shell"],
    budget: { maxWallClockMs: 1000 },
    metadata: {
      task_id: "t-1",
      worktree_id: "wt-1",
      workflow_id: "default-task",
      step_id: "implementation",
      agent_id: "agents/implementation",
      model_id: "haiku",
    },
    ...overrides,
  };
}

const done: OptioRunResult = {
  status: "succeeded",
  answer: "Done.",
  changed: ["/tmp/wt-task/a.ts"],
  toolCalls: 3,
  usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 20 },
  costUsd: 0.02,
  signOffs: [],
};

function fake(result: OptioRunResult = done) {
  const calls: OptioRunInput[] = [];
  const runClaude = async (input: OptioRunInput) => {
    calls.push(input);
    return result;
  };
  return { calls, runClaude };
}

describe("optio-run adapter", () => {
  it("is a selectable backend", () => {
    expect(isCodingBackendId("optio-run")).toBe(true);
    expect(createCodingAgent("optio-run", { runClaude: fake().runClaude }).id).toBe("optio-run");
  });

  it("runs the Claude CLI in the worktree with full access on an implementation step and maps the result", async () => {
    const runner = fake();
    const output = await createOptioRunAdapter({
      runClaude: runner.runClaude,
      env: { OPENROUTER_API_KEY: "k" },
    }).run(sampleInput());
    expect(runner.calls[0]).toMatchObject({
      cwd: "/tmp/wt-task",
      prompt: "follow the spec\n\nimplement the seam",
      task: "implement the seam",
      access: "full",
      model: "haiku",
      jev: {},
      checkDone: true,
      timeoutMs: 1000,
    });
    expect(output).toMatchObject({
      status: "succeeded",
      pr_ready: true,
      diff_summary: "/tmp/wt-task/a.ts",
      usage: {
        provider: "optio-run",
        input_tokens: 10,
        output_tokens: 5,
        cached_tokens: 100,
        cost_usd: 0.02,
      },
    });
  });

  it("asks Jev only when a key is set", async () => {
    const runner = fake();
    await createOptioRunAdapter({ runClaude: runner.runClaude, env: {} }).run(sampleInput());
    expect(runner.calls[0].jev).toBeUndefined();
    expect(runner.calls[0].checkDone).toBe(false);
    expect(hasJevKey({ JEV_API_KEY: "x" })).toBe(true);
    expect(hasJevKey({})).toBe(false);
  });

  it("refuses a run whose tools exceed the tier, before anything starts", async () => {
    const runner = fake();
    const output = await createOptioRunAdapter({ runClaude: runner.runClaude }).run(
      sampleInput({ permission_tier: "read-only", allowed_tools: ["edit"] }),
    );
    expect(runner.calls).toHaveLength(0);
    expect(output).toMatchObject({ status: "failed", error_class: "permission_denied" });
  });

  it("runs a read-only tier with read access", async () => {
    const runner = fake();
    await createOptioRunAdapter({ runClaude: runner.runClaude }).run(
      sampleInput({
        permission_tier: "read-only",
        allowed_tools: ["read"],
        metadata: { ...sampleInput().metadata, step_id: "dispatch_review" },
      }),
    );
    expect(runner.calls[0].access).toBe("read");
  });

  it("answers what Jev leaves open with the tool gate: a plain command yes, a destructive one no", async () => {
    const runner = fake();
    await createOptioRunAdapter({ runClaude: runner.runClaude }).run(sampleInput());
    const ask = runner.calls[0].askPerson!;
    expect(await ask({ tool: "Bash", kind: "execute", action: "npm test", input: {} })).toBe(
      "allow",
    );
    expect(await ask({ tool: "Bash", kind: "execute", action: "sudo rm -rf /", input: {} })).toBe(
      "deny",
    );
    expect(
      await ask({ tool: "Bash", kind: "execute", action: "git push origin main", input: {} }),
    ).toBe("deny");
    expect(
      await ask({ tool: "Edit", kind: "edit", action: "Edit /tmp/wt-task/a.ts", input: {} }),
    ).toBe("allow");
  });

  it("maps a timeout, a usage limit and a missing runner to the adapter's statuses", async () => {
    const timeout = await createOptioRunAdapter({
      runClaude: fake({ ...done, status: "timeout", changed: [] }).runClaude,
    }).run(sampleInput());
    expect(timeout).toMatchObject({
      status: "budget_exhausted",
      error_class: "wall_clock",
      pr_ready: false,
    });
    const limited = await createOptioRunAdapter({
      runClaude: fake({ ...done, status: "failed", error: "You've hit your session limit" })
        .runClaude,
    }).run(sampleInput());
    expect(limited).toMatchObject({ status: "budget_exhausted", error_class: "budget_exhausted" });
    const missing = await createOptioRunAdapter({}).run(sampleInput());
    expect(missing).toMatchObject({ status: "failed", error_class: "runner_missing" });
  });
});
