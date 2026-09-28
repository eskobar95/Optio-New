import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SKILL_PICK_MIN_CONFIDENCE,
  PINNED_JEV_MODEL,
  SkillPickTimeoutError,
  applySkillPick,
  createInMemorySkillPickLogStore,
  createJevClient,
  createJevSkillPickPort,
  evaluateSkillPickWithGate,
  filterToRegistry,
  formatSkillPickInstructions,
  runSkillPickGate,
  type JevFetchLike,
  type SkillPickLogEntry,
} from "../src/index.js";

function jsonResponse(body: unknown, status = 200): Awaited<ReturnType<JevFetchLike>> {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe("SkillPick contracts", () => {
  it("defaults minConfidence to 0.7", () => {
    expect(DEFAULT_SKILL_PICK_MIN_CONFIDENCE).toBe(0.7);
  });

  it("filterToRegistry drops unknowns and duplicates", () => {
    expect(filterToRegistry(["tdd", "evil", "tdd", "code-review"], ["tdd", "code-review"])).toEqual(
      ["tdd", "code-review"],
    );
  });
});

describe("runSkillPickGate", () => {
  it("returns decided subset and pins jev-1.13.0", async () => {
    const fetchImpl: JevFetchLike = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        model?: string;
        questions?: { skill_pick?: unknown };
        state?: { skill_registry?: string[] };
      };
      expect(body.model).toBe(PINNED_JEV_MODEL);
      expect(body.questions?.skill_pick).toBeTruthy();
      expect(body.state?.skill_registry).toEqual(["tdd", "code-review", "bot-session"]);
      return jsonResponse({
        answers: {
          skill_pick: {
            skill_ids: ["tdd", "not-allowed"],
            mcp_tool_ids: ["read", "shell", "bogus"],
            confidence: 0.91,
          },
        },
      });
    };
    const client = createJevClient({
      env: { OPTIO_NEW_JEV_BASE_URL: "https://jev.test" },
      fetchImpl,
    });

    const outcome = await runSkillPickGate({
      client,
      state: {
        task_id: "t1",
        prompt: "add unit tests",
        task_type: "bugfix",
        skill_registry: ["tdd", "code-review", "bot-session"],
        mcp_registry: ["read", "shell"],
      },
    });
    expect(outcome).toEqual({
      kind: "decided",
      skillIds: ["tdd"],
      mcpToolIds: ["read", "shell"],
      confidence: 0.91,
    });
    expect(applySkillPick(outcome)).toEqual({
      source: "skill_pick",
      skillIds: ["tdd"],
      mcpToolIds: ["read", "shell"],
      confidence: 0.91,
    });
  });

  it("soft timeout maps to empty passthrough", async () => {
    const fetchImpl: JevFetchLike = async () =>
      new Promise(() => {
        /* hang */
      });
    const client = createJevClient({
      env: { OPTIO_NEW_JEV_BASE_URL: "https://jev.test" },
      timeoutMs: 20,
      fetchImpl,
    });

    const outcome = await runSkillPickGate({
      client,
      state: { skill_registry: ["tdd"] },
      config: { timeoutMs: 20, passthroughOnTimeout: true },
    });
    expect(outcome).toMatchObject({ kind: "passthrough", reason: "timeout" });
    expect(applySkillPick(outcome)).toMatchObject({
      source: "passthrough",
      skillIds: [],
      mcpToolIds: [],
      reason: "timeout",
    });
  });

  it("returns error when timeout and passthroughOnTimeout is false", async () => {
    const fetchImpl: JevFetchLike = async () =>
      new Promise(() => {
        /* hang */
      });
    const client = createJevClient({
      env: { OPTIO_NEW_JEV_BASE_URL: "https://jev.test" },
      fetchImpl,
    });

    const outcome = await runSkillPickGate({
      client,
      state: {},
      config: { timeoutMs: 20, passthroughOnTimeout: false },
    });
    expect(outcome.kind).toBe("error");
    expect(() => applySkillPick(outcome)).toThrow(SkillPickTimeoutError);
  });

  it("passthrough on low confidence", async () => {
    const client = createJevClient({
      env: { OPTIO_NEW_JEV_BASE_URL: "https://jev.test" },
      fetchImpl: async () =>
        jsonResponse({
          answers: {
            skill_pick: { skill_ids: ["tdd"], confidence: 0.2, notes: "unsure" },
          },
        }),
    });

    const outcome = await runSkillPickGate({
      client,
      state: { skill_registry: ["tdd"] },
      config: { minConfidence: 0.7 },
    });
    expect(outcome).toEqual({
      kind: "passthrough",
      reason: "low_confidence",
      confidence: 0.2,
      notes: "unsure",
    });
  });

  it("passthrough undecided when answer missing", async () => {
    const client = createJevClient({
      env: { OPTIO_NEW_JEV_BASE_URL: "https://jev.test" },
      fetchImpl: async () => jsonResponse({ answers: {} }),
    });
    await expect(runSkillPickGate({ client, state: {} })).resolves.toEqual({
      kind: "passthrough",
      reason: "undecided",
    });
  });

  it("passthrough on HTTP errors preserves status", async () => {
    const client = createJevClient({
      env: { OPTIO_NEW_JEV_BASE_URL: "https://jev.test" },
      fetchImpl: async () => jsonResponse({ error: "nope" }, 503),
    });
    const outcome = await runSkillPickGate({ client, state: {} });
    expect(outcome).toEqual({ kind: "passthrough", reason: "http", status: 503 });
  });
});

describe("evaluateSkillPickWithGate (opt-in)", () => {
  it("logs task_type, selected skills, and outcome; persists to skill_pick_logs store", async () => {
    const logs: SkillPickLogEntry[] = [];
    const store = createInMemorySkillPickLogStore();
    const client = createJevClient({
      env: { OPTIO_NEW_JEV_BASE_URL: "https://jev.test" },
      fetchImpl: async () =>
        jsonResponse({
          answers: {
            skill_pick: {
              skill_ids: ["tdd", "code-review"],
              mcp_tool_ids: ["read"],
              confidence: 0.88,
            },
          },
        }),
    });

    const decision = await evaluateSkillPickWithGate({
      client,
      state: {
        task_id: "t1",
        task_type: "bugfix",
        skill_registry: ["tdd", "code-review", "bot-session"],
        mcp_registry: ["read", "shell"],
      },
      onLog: (entry) => {
        logs.push(entry);
      },
      logStore: store,
      workspaceId: "11111111-1111-4111-8111-111111111111",
    });

    expect(decision).toEqual({
      source: "skill_pick",
      skillIds: ["tdd", "code-review"],
      mcpToolIds: ["read"],
      confidence: 0.88,
    });
    expect(logs).toEqual([
      {
        task_id: "t1",
        task_type: "bugfix",
        selected_skill_ids: ["tdd", "code-review"],
        selected_mcp_tool_ids: ["read"],
        outcome: "selected",
        confidence: 0.88,
      },
    ]);
    expect(store.entries).toEqual([
      {
        workspaceId: "11111111-1111-4111-8111-111111111111",
        taskId: "t1",
        taskType: "bugfix",
        selectedSkillIds: ["tdd", "code-review"],
        outcome: "selected",
      },
    ]);
  });

  it("logs soft passthrough with empty selection", async () => {
    const onLog = vi.fn();
    const client = createJevClient({
      env: { OPTIO_NEW_JEV_BASE_URL: "https://jev.test" },
      fetchImpl: async () => jsonResponse({ answers: {} }),
    });

    const decision = await evaluateSkillPickWithGate({
      client,
      state: { task_type: "feature", skill_registry: ["tdd"] },
      onLog,
    });
    expect(decision).toEqual({
      source: "passthrough",
      skillIds: [],
      mcpToolIds: [],
      reason: "undecided",
    });
    expect(onLog).toHaveBeenCalledWith({
      task_type: "feature",
      selected_skill_ids: [],
      selected_mcp_tool_ids: [],
      outcome: "passthrough",
      reason: "undecided",
    });
  });

  it("logs hard timeout before rethrowing", async () => {
    const onLog = vi.fn();
    const fetchImpl: JevFetchLike = async () =>
      new Promise(() => {
        /* hang */
      });
    const client = createJevClient({
      env: { OPTIO_NEW_JEV_BASE_URL: "https://jev.test" },
      fetchImpl,
    });

    await expect(
      evaluateSkillPickWithGate({
        client,
        state: { task_type: "chore" },
        config: { timeoutMs: 20, passthroughOnTimeout: false },
        onLog,
      }),
    ).rejects.toBeInstanceOf(SkillPickTimeoutError);

    expect(onLog).toHaveBeenCalledWith(
      expect.objectContaining({
        task_type: "chore",
        outcome: "error",
        reason: "timeout",
        selected_skill_ids: [],
      }),
    );
  });
});

describe("createJevSkillPickPort", () => {
  it("implements JevSkillPickPort and formats instructions without stub label", async () => {
    const client = createJevClient({
      env: { OPTIO_NEW_JEV_BASE_URL: "https://jev.test" },
      fetchImpl: async () =>
        jsonResponse({
          answers: {
            skill_pick: {
              skill_ids: ["tdd"],
              mcp_tool_ids: ["read"],
              confidence: 0.9,
            },
          },
        }),
    });
    const port = createJevSkillPickPort({ client });
    const result = await port.pickSkills({
      taskId: "t1",
      stage: "implement",
      prompt: "write tests",
      registry: ["tdd", "code-review"],
      mcpRegistry: ["read", "shell"],
      taskType: "bugfix",
    });
    expect(result).toEqual({
      skillIds: ["tdd"],
      mcpToolIds: ["read"],
      reason: "skill_pick",
      confidence: 0.9,
    });
    const block = formatSkillPickInstructions(result);
    expect(block).toContain("## Jev skill pick (skill_pick)");
    expect(block).toContain("Skills: tdd");
    expect(block).toContain("MCP tools: read");
    expect(block).not.toContain("(stub)");
  });
});
