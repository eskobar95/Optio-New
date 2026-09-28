import { describe, expect, it } from "vitest";
import { createFlueAdapter } from "../src/adapters/flue/index.js";
import {
  createPassthroughJevSkillPick,
  formatSkillPickInstructions,
  type JevSkillPickPort,
} from "../src/adapters/flue/jev-lazy-load.js";
import {
  appendReviewFeedback,
  formatAccumulatedFeedback,
} from "../src/adapters/flue/review-feedback.js";
import {
  FLUE_FEEDBACK_MAX_ITEMS,
  FLUE_IMPLEMENT_BINDING_STAGE,
  InMemoryFlueSessionBindingStore,
  flueBindingKey,
} from "../src/adapters/flue/session-binding.js";
import type { CodingAgentInput } from "../src/adapters/coding-agent.js";

const sessionIdA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const sessionIdB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function sampleInput(taskId = "t-bind"): CodingAgentInput {
  return {
    worktree_path: "/tmp/wt-bind",
    prompt: "implement seam",
    instructions: "follow spec",
    allowed_tools: ["edit"],
    budget: {},
    metadata: {
      task_id: taskId,
      worktree_id: "wt-bind",
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

function parseBody(init?: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
}

describe("FlueSessionBindingStore", () => {
  it("maps taskId/stage and preserves feedback on put without feedback field", () => {
    const store = new InMemoryFlueSessionBindingStore();
    expect(flueBindingKey("t1", FLUE_IMPLEMENT_BINDING_STAGE)).toBe("t1::implement");

    store.put({
      taskId: "t1",
      stage: FLUE_IMPLEMENT_BINDING_STAGE,
      flueSessionId: sessionIdA,
      durableConversationId: "flue-conv-1",
      feedback: [
        {
          source: "review",
          summary: "needs tests",
          mustFix: ["add unit test"],
        },
      ],
    });

    const got = store.get("t1", FLUE_IMPLEMENT_BINDING_STAGE);
    expect(got?.durableConversationId).toBe("flue-conv-1");
    expect(got?.feedback).toHaveLength(1);

    store.put({
      taskId: "t1",
      stage: FLUE_IMPLEMENT_BINDING_STAGE,
      flueSessionId: sessionIdB,
      durableConversationId: "flue-conv-1",
    });
    expect(store.get("t1", FLUE_IMPLEMENT_BINDING_STAGE)?.flueSessionId).toBe(sessionIdB);
    expect(store.get("t1", FLUE_IMPLEMENT_BINDING_STAGE)?.feedback).toHaveLength(1);

    store.clear("t1", FLUE_IMPLEMENT_BINDING_STAGE);
    expect(store.get("t1", FLUE_IMPLEMENT_BINDING_STAGE)).toBeUndefined();
  });
});

describe("review → implement feedback stub", () => {
  it("accumulates structured feedback on the implement binding", () => {
    const store = new InMemoryFlueSessionBindingStore();
    store.put({
      taskId: "t-fb",
      stage: FLUE_IMPLEMENT_BINDING_STAGE,
      flueSessionId: sessionIdA,
      durableConversationId: "flue-conv-fb",
    });

    appendReviewFeedback(store, "t-fb", {
      source: "review",
      summary: "standards fail",
      mustFix: ["merge helper", "fix flake"],
      verdict: "fail",
      files: ["src/gate.ts"],
      at: "2026-09-28T12:00:00.000Z",
    });
    appendReviewFeedback(store, "t-fb", {
      source: "review",
      summary: "still open",
      mustFix: ["docs note"],
    });

    const binding = store.get("t-fb", FLUE_IMPLEMENT_BINDING_STAGE);
    expect(binding?.feedback).toHaveLength(2);
    expect(binding?.durableConversationId).toBe("flue-conv-fb");

    const formatted = formatAccumulatedFeedback(binding?.feedback ?? []);
    expect(formatted).toContain("Accumulated feedback");
    expect(formatted).toContain("Verdict: fail");
    expect(formatted).toContain("merge helper");
    expect(formatted).toContain("still open");
  });

  it("records pending feedback before the first accept", () => {
    const store = new InMemoryFlueSessionBindingStore();
    appendReviewFeedback(store, "t-pending", {
      source: "review",
      summary: "early note",
      mustFix: ["ship binding first"],
    });
    const pending = store.get("t-pending", FLUE_IMPLEMENT_BINDING_STAGE);
    expect(pending?.durableConversationId).toBe("");
    expect(pending?.feedback).toHaveLength(1);
  });

  it("caps feedback at FLUE_FEEDBACK_MAX_ITEMS", () => {
    const store = new InMemoryFlueSessionBindingStore();
    for (let i = 0; i < FLUE_FEEDBACK_MAX_ITEMS + 5; i++) {
      appendReviewFeedback(store, "t-cap", {
        source: "review",
        summary: `note-${i}`,
        mustFix: [`fix-${i}`],
      });
    }
    const binding = store.get("t-cap", FLUE_IMPLEMENT_BINDING_STAGE);
    expect(binding?.feedback).toHaveLength(FLUE_FEEDBACK_MAX_ITEMS);
    expect(binding?.feedback[0]?.summary).toBe("note-5");
    expect(binding?.feedback.at(-1)?.summary).toBe(`note-${FLUE_FEEDBACK_MAX_ITEMS + 4}`);
  });
});

describe("Jev skill-pick port stub", () => {
  it("passthrough returns empty skillIds with no network", async () => {
    const port = createPassthroughJevSkillPick();
    const result = await port.pickSkills({
      taskId: "t1",
      stage: "implement",
      prompt: "do the thing",
      registry: ["tdd", "code-review"],
    });
    expect(result).toEqual({ skillIds: [], reason: "passthrough_stub" });
    expect(formatSkillPickInstructions(result)).toBe("");
  });

  it("formatSkillPickInstructions lists chosen ids", () => {
    expect(
      formatSkillPickInstructions({ skillIds: ["tdd", "bot-session"], reason: "mock" }),
    ).toContain("Skills: tdd, bot-session");
  });
});

describe("Flue adapter session continuity", () => {
  it("accepts then resumes the same durableConversationId for the same task", async () => {
    const store = new InMemoryFlueSessionBindingStore();
    const dispatchBodies: Record<string, unknown>[] = [];

    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/dispatch") && init?.method === "POST") {
        const body = parseBody(init);
        dispatchBodies.push(body);
        const resumeId =
          typeof body.durableConversationId === "string" ? body.durableConversationId.trim() : "";
        return jsonResponse(200, {
          sessionId: resumeId ? sessionIdB : sessionIdA,
          durableConversationId: resumeId || "flue-conv-cont",
          status: resumeId ? "resumed" : "accepted",
        });
      }
      if (url.endsWith("/start") && init?.method === "POST") {
        const body = parseBody(init);
        return jsonResponse(200, {
          sessionId: body.sessionId,
          branch: "flue/t-bind",
          usageEvents: [],
          status: "succeeded",
          logs: "ok",
        });
      }
      return jsonResponse(404, { error: "not_found" });
    };

    const agent = createFlueAdapter({ flue: { fetchImpl, sessionBinding: store, maxAttempts: 2 } });

    const first = await agent.run(sampleInput());
    expect(first.status).toBe("succeeded");
    expect(dispatchBodies[0]?.durableConversationId).toBeUndefined();
    expect(store.get("t-bind", FLUE_IMPLEMENT_BINDING_STAGE)?.durableConversationId).toBe(
      "flue-conv-cont",
    );

    const second = await agent.run(sampleInput());
    expect(second.status).toBe("succeeded");
    expect(dispatchBodies[1]?.durableConversationId).toBe("flue-conv-cont");
    expect(store.get("t-bind", FLUE_IMPLEMENT_BINDING_STAGE)?.durableConversationId).toBe(
      "flue-conv-cont",
    );
  });

  it("injects accumulated review feedback into the next dispatch instructions", async () => {
    const store = new InMemoryFlueSessionBindingStore();
    store.put({
      taskId: "t-bind",
      stage: FLUE_IMPLEMENT_BINDING_STAGE,
      flueSessionId: sessionIdA,
      durableConversationId: "flue-conv-fb2",
    });
    appendReviewFeedback(store, "t-bind", {
      source: "review",
      summary: "retry with context",
      mustFix: ["fix seam overlap"],
      verdict: "fail",
    });

    let instructions: unknown;
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/dispatch")) {
        const body = parseBody(init);
        instructions = body.instructions;
        return jsonResponse(200, {
          sessionId: sessionIdA,
          durableConversationId: "flue-conv-fb2",
          status: "resumed",
        });
      }
      return jsonResponse(200, {
        sessionId: sessionIdA,
        branch: "flue/t-bind",
        usageEvents: [],
        status: "succeeded",
      });
    };

    const agent = createFlueAdapter({ flue: { fetchImpl, sessionBinding: store } });
    await agent.run(sampleInput());
    expect(String(instructions)).toContain("follow spec");
    expect(String(instructions)).toContain("Accumulated feedback");
    expect(String(instructions)).toContain("fix seam overlap");
    expect(store.get("t-bind", FLUE_IMPLEMENT_BINDING_STAGE)?.feedback).toEqual([]);
  });

  it("keeps pending feedback through first accept and binds session ids", async () => {
    const store = new InMemoryFlueSessionBindingStore();
    appendReviewFeedback(store, "t-bind", {
      source: "review",
      summary: "early note",
      mustFix: ["ship binding first"],
    });

    let instructions: unknown;
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/dispatch")) {
        instructions = parseBody(init).instructions;
        return jsonResponse(200, {
          sessionId: sessionIdA,
          durableConversationId: "flue-conv-pending",
          status: "accepted",
        });
      }
      return jsonResponse(200, {
        sessionId: sessionIdA,
        branch: "flue/t-bind",
        usageEvents: [],
        status: "succeeded",
      });
    };

    const agent = createFlueAdapter({ flue: { fetchImpl, sessionBinding: store } });
    await agent.run(sampleInput());
    expect(String(instructions)).toContain("early note");
    expect(String(instructions)).toContain("ship binding first");
    expect(store.get("t-bind", FLUE_IMPLEMENT_BINDING_STAGE)).toMatchObject({
      flueSessionId: sessionIdA,
      durableConversationId: "flue-conv-pending",
      feedback: [],
    });
  });

  it("puts binding on dispatch even when start fails", async () => {
    const store = new InMemoryFlueSessionBindingStore();
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/dispatch")) {
        return jsonResponse(200, {
          sessionId: sessionIdA,
          durableConversationId: "flue-conv-partial",
          status: "accepted",
        });
      }
      return jsonResponse(503, { error: "unavailable" });
    };

    const agent = createFlueAdapter({
      flue: { fetchImpl, sessionBinding: store, maxAttempts: 1 },
    });
    const output = await agent.run(sampleInput());
    expect(output.status).toBe("failed");
    expect(store.get("t-bind", FLUE_IMPLEMENT_BINDING_STAGE)?.durableConversationId).toBe(
      "flue-conv-partial",
    );
  });

  it("fail-opens when skill-pick throws", async () => {
    const store = new InMemoryFlueSessionBindingStore();
    const skillPick: JevSkillPickPort = {
      async pickSkills() {
        throw new Error("jev down");
      },
    };

    let instructions: unknown;
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/dispatch")) {
        instructions = parseBody(init).instructions;
        return jsonResponse(200, {
          sessionId: sessionIdA,
          durableConversationId: "flue-conv-failopen",
          status: "accepted",
        });
      }
      return jsonResponse(200, {
        sessionId: sessionIdA,
        branch: "flue/t-bind",
        usageEvents: [],
        status: "succeeded",
      });
    };

    const agent = createFlueAdapter({
      flue: { fetchImpl, sessionBinding: store, skillPick },
    });
    const output = await agent.run(sampleInput());
    expect(output.status).toBe("succeeded");
    expect(String(instructions ?? "")).not.toContain("Jev skill pick");
  });

  it("calls injectable skill-pick and attaches chosen skills to instructions", async () => {
    const store = new InMemoryFlueSessionBindingStore();
    const skillPick: JevSkillPickPort = {
      async pickSkills() {
        return { skillIds: ["tdd"], reason: "unit_test_mock" };
      },
    };

    let instructions: unknown;
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/dispatch")) {
        instructions = parseBody(init).instructions;
        return jsonResponse(200, {
          sessionId: sessionIdA,
          durableConversationId: "flue-conv-skills",
          status: "accepted",
        });
      }
      return jsonResponse(200, {
        sessionId: sessionIdA,
        branch: "flue/t-bind",
        usageEvents: [],
        status: "succeeded",
      });
    };

    const agent = createFlueAdapter({
      flue: {
        fetchImpl,
        sessionBinding: store,
        skillPick,
        skillRegistry: ["tdd", "code-review"],
      },
    });
    await agent.run(sampleInput());
    expect(String(instructions)).toContain("Jev skill pick (stub)");
    expect(String(instructions)).toContain("Skills: tdd");
  });
});
