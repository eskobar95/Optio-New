import { describe, expect, it } from "vitest";
import {
  FlueDispatchRequestSchema,
  FlueDispatchResponseSchema,
  FlueHealthResponseSchema,
  FlueStartRequestSchema,
  FlueStartResponseSchema,
  FlueUsageEventSchema,
} from "../src/adapters/flue/contract.js";

const sessionId = "11111111-1111-4111-8111-111111111111";

describe("flue contract schemas", () => {
  it("accepts a valid dispatch request and fills sandboxMode default", () => {
    const parsed = FlueDispatchRequestSchema.parse({
      taskId: "t-1",
      worktreeId: "wt-1",
      workflowId: "default-task",
      stepId: "implementation",
      agentId: "agents/implementation",
      workspaceRef: "/tmp/wt",
      prompt: "implement seam",
      allowedTools: ["edit"],
    });
    expect(parsed.sandboxMode).toBe("local");
  });

  it("rejects docker sandbox mode", () => {
    const result = FlueDispatchRequestSchema.safeParse({
      taskId: "t-1",
      worktreeId: "wt-1",
      workflowId: "default-task",
      stepId: "implementation",
      agentId: "agents/implementation",
      workspaceRef: "/tmp/wt",
      prompt: "x",
      sandboxMode: "docker",
    });
    expect(result.success).toBe(false);
  });

  it("round-trips dispatch and start responses", () => {
    const dispatch = FlueDispatchResponseSchema.parse({
      sessionId,
      durableConversationId: "flue-conv-1",
      status: "accepted",
    });
    expect(dispatch.status).toBe("accepted");

    const start = FlueStartResponseSchema.parse({
      sessionId,
      branch: "flue/t-1",
      prUrl: "https://github.com/eskobar95/Optio-New/pull/1",
      usageEvents: [
        {
          kind: "token",
          inputTokens: 10,
          outputTokens: 4,
          provider: "flue",
        },
      ],
      status: "succeeded",
    });
    expect(start.prUrl).toContain("/pull/1");
    expect(start.usageEvents).toHaveLength(1);
  });

  it("defaults usageEvents on start and provider on usage events", () => {
    const start = FlueStartResponseSchema.parse({
      sessionId,
      branch: "flue/t-1",
      status: "succeeded",
    });
    expect(start.usageEvents).toEqual([]);

    const event = FlueUsageEventSchema.parse({ kind: "cost", costUsd: 0.01 });
    expect(event.provider).toBe("flue");
  });

  it("rejects invalid start request and health", () => {
    expect(FlueStartRequestSchema.safeParse({ sessionId: "nope" }).success).toBe(false);
    expect(FlueHealthResponseSchema.safeParse({ ok: true, service: "kit-harness" }).success).toBe(
      false,
    );
    expect(FlueHealthResponseSchema.parse({ ok: true, service: "flue" })).toEqual({
      ok: true,
      service: "flue",
    });
  });
});
