import { describe, expect, it, vi } from "vitest";
import type { CodingAgentInput } from "../src/adapters/coding-agent.js";
import { createFlueClient, FlueHttpError } from "../src/adapters/flue/client.js";
import { createFlueAdapter } from "../src/adapters/flue/index.js";
import { createCodingAgent, resolveCodingBackend } from "../src/adapters/select.js";

const sessionId = "22222222-2222-4222-8222-222222222222";

function sampleInput(): CodingAgentInput {
  return {
    worktree_path: "/tmp/wt-flue",
    prompt: "implement seam",
    instructions: "follow spec",
    allowed_tools: ["edit"],
    budget: {},
    metadata: {
      task_id: "t-flue",
      worktree_id: "wt-flue",
      workflow_id: "default-task",
      step_id: "implementation",
      agent_id: "agents/implementation",
      model_id: "gpt-4o",
    },
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Flue CodingAgent adapter", () => {
  it("maps dispatch+start to CodingAgentOutput and keeps zero usage", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/dispatch") && init?.method === "POST") {
        return jsonResponse(200, {
          sessionId,
          durableConversationId: "flue-conv-a",
          status: "accepted",
        });
      }
      if (url.endsWith("/start") && init?.method === "POST") {
        return jsonResponse(200, {
          sessionId,
          branch: "flue/t-flue",
          prUrl: "https://github.com/eskobar95/Optio-New/pull/99",
          usageEvents: [
            {
              kind: "token",
              inputTokens: 0,
              outputTokens: 0,
              provider: "flue",
              modelId: "gpt-4o",
            },
          ],
          status: "succeeded",
          logs: "ok",
        });
      }
      return jsonResponse(404, { error: "not_found" });
    });

    const agent = createFlueAdapter({ flue: { fetchImpl, maxAttempts: 3 } });
    expect(agent.id).toBe("flue");
    const output = await agent.run(sampleInput());
    expect(output.status).toBe("succeeded");
    expect(output.branch).toBe("flue/t-flue");
    expect(output.pr_ready).toBe(true);
    expect(output.diff_summary).toBeUndefined();
    expect(output.logs).toBe("ok\nprUrl=https://github.com/eskobar95/Optio-New/pull/99");
    expect(output.usage).toEqual({
      provider: "flue",
      input_tokens: 0,
      output_tokens: 0,
      model_id: "gpt-4o",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      signal: expect.any(AbortSignal),
    });
  });

  it("sets pr_ready false when Flue status is failed even if prUrl is set", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/dispatch")) {
        return jsonResponse(200, {
          sessionId,
          durableConversationId: "flue-conv-fail",
          status: "accepted",
        });
      }
      return jsonResponse(200, {
        sessionId,
        branch: "flue/t-flue",
        prUrl: "https://github.com/eskobar95/Optio-New/pull/1",
        usageEvents: [],
        status: "failed",
        errorClass: "builder_failed",
      });
    });

    const output = await createFlueAdapter({ flue: { fetchImpl } }).run(sampleInput());
    expect(output.status).toBe("failed");
    expect(output.pr_ready).toBe(false);
    expect(output.error_class).toBe("builder_failed");
  });

  it("re-dispatches on 5xx up to maxAttempts then succeeds", async () => {
    let dispatchCalls = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/dispatch")) {
        dispatchCalls += 1;
        if (dispatchCalls < 3) return jsonResponse(503, { error: "unavailable" });
        return jsonResponse(200, {
          sessionId,
          durableConversationId: "flue-conv-retry",
          status: "accepted",
        });
      }
      return jsonResponse(200, {
        sessionId,
        branch: "flue/t-flue",
        usageEvents: [],
        status: "succeeded",
      });
    });

    const client = createFlueClient({ fetchImpl, maxAttempts: 3 });
    const result = await client.dispatchAndStart({
      taskId: "t-flue",
      worktreeId: "wt",
      workflowId: "default-task",
      stepId: "implementation",
      agentId: "agents/implementation",
      workspaceRef: "/tmp/wt",
      prompt: "go",
      sandboxMode: "local",
      allowedTools: [],
    });
    expect(result.start.branch).toBe("flue/t-flue");
    expect(dispatchCalls).toBe(3);
  });

  it("retries start only after a successful dispatch", async () => {
    let dispatchCalls = 0;
    let startCalls = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/dispatch")) {
        dispatchCalls += 1;
        return jsonResponse(200, {
          sessionId,
          durableConversationId: "flue-conv-start-retry",
          status: "accepted",
        });
      }
      startCalls += 1;
      if (startCalls < 3) return jsonResponse(503, { error: "unavailable" });
      return jsonResponse(200, {
        sessionId,
        branch: "flue/t-flue",
        usageEvents: [],
        status: "succeeded",
      });
    });

    const client = createFlueClient({ fetchImpl, maxAttempts: 3 });
    await client.dispatchAndStart({
      taskId: "t-flue",
      worktreeId: "wt",
      workflowId: "default-task",
      stepId: "implementation",
      agentId: "agents/implementation",
      workspaceRef: "/tmp/wt",
      prompt: "go",
      sandboxMode: "local",
      allowedTools: [],
    });
    expect(dispatchCalls).toBe(1);
    expect(startCalls).toBe(3);
  });

  it("does not retry on 4xx", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(400, { error: "invalid_request" }));
    const client = createFlueClient({ fetchImpl, maxAttempts: 3 });
    await expect(
      client.dispatchAndStart({
        taskId: "t-flue",
        worktreeId: "wt",
        workflowId: "default-task",
        stepId: "implementation",
        agentId: "agents/implementation",
        workspaceRef: "/tmp/wt",
        prompt: "go",
        sandboxMode: "local",
        allowedTools: [],
      }),
    ).rejects.toBeInstanceOf(FlueHttpError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("maps AbortError to retryable flue_timeout", async () => {
    const abort = new DOMException("The operation was aborted", "AbortError");
    const fetchImpl = vi.fn(async () => {
      throw abort;
    });
    const client = createFlueClient({ fetchImpl, maxAttempts: 1 });
    await expect(
      client.dispatch({
        taskId: "t-flue",
        worktreeId: "wt",
        workflowId: "default-task",
        stepId: "implementation",
        agentId: "agents/implementation",
        workspaceRef: "/tmp/wt",
        prompt: "go",
        sandboxMode: "local",
        allowedTools: [],
      }),
    ).rejects.toMatchObject({ errorClass: "flue_timeout", retryable: true });
  });

  it("returns failed CodingAgentOutput after re-dispatch exhaustion", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(502, { error: "bad_gateway" }));
    const agent = createFlueAdapter({ flue: { fetchImpl, maxAttempts: 2 } });
    const output = await agent.run(sampleInput());
    expect(output.status).toBe("failed");
    expect(output.error_class).toBe("flue_server_error");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("is selectable via resolveCodingBackend / createCodingAgent", () => {
    expect(resolveCodingBackend({ stepCodingBackend: "flue" })).toBe("flue");
    const agent = createCodingAgent("flue", {
      flue: {
        fetchImpl: async () => jsonResponse(200, { ok: true, service: "flue" }),
      },
    });
    expect(agent.id).toBe("flue");
  });
});
