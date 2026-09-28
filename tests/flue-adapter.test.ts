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
  it("maps dispatch+start to CodingAgentOutput", async () => {
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
              inputTokens: 12,
              outputTokens: 3,
              provider: "flue",
              modelId: "gpt-4o",
            },
          ],
          status: "succeeded",
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
    expect(output.usage).toEqual({
      provider: "flue",
      input_tokens: 12,
      output_tokens: 3,
      model_id: "gpt-4o",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
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
