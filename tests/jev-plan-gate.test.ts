import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PLAN_MIN_CONFIDENCE,
  PINNED_JEV_MODEL,
  PlanGateLabelSchema,
  PlanGateTimeoutError,
  applyPlanGate,
  createJevClient,
  evaluatePlanWithGate,
  runPlanGate,
  type JevFetchLike,
  type PlanGateLogEntry,
} from "../src/index.js";

function jsonResponse(body: unknown, status = 200): Awaited<ReturnType<JevFetchLike>> {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe("PlanGate contracts", () => {
  it("defaults minConfidence to 0.7", () => {
    expect(DEFAULT_PLAN_MIN_CONFIDENCE).toBe(0.7);
  });

  it("parses plan gate labels", () => {
    expect(PlanGateLabelSchema.parse("auto_clear")).toBe("auto_clear");
    expect(PlanGateLabelSchema.parse("needs_revision")).toBe("needs_revision");
    expect(PlanGateLabelSchema.parse("needs_human")).toBe("needs_human");
  });
});

describe("runPlanGate", () => {
  it("returns decided auto_clear on high confidence and pins jev-1.13.0", async () => {
    const fetchImpl: JevFetchLike = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        model?: string;
        questions?: { plan?: unknown };
      };
      expect(body.model).toBe(PINNED_JEV_MODEL);
      expect(body.questions?.plan).toBeTruthy();
      return jsonResponse({
        answers: { plan: { choice: "auto_clear", confidence: 0.92 } },
      });
    };
    const client = createJevClient({
      env: { OPTIO_NEW_JEV_BASE_URL: "https://jev.test" },
      fetchImpl,
    });

    const outcome = await runPlanGate({
      client,
      state: { task_id: "t1", plan_text: "fix typo in README", task_type: "docs" },
    });
    expect(outcome).toEqual({
      kind: "decided",
      label: "auto_clear",
      confidence: 0.92,
    });
    expect(applyPlanGate(outcome)).toEqual({
      action: "proceed",
      source: "plan_gate",
      label: "auto_clear",
      confidence: 0.92,
    });
  });

  it("maps needs_revision to revise", async () => {
    const client = createJevClient({
      env: { OPTIO_NEW_JEV_BASE_URL: "https://jev.test" },
      fetchImpl: async () =>
        jsonResponse({
          answers: {
            plan: { choice: "needs_revision", confidence: 0.85, notes: "missing AC" },
          },
        }),
    });
    const outcome = await runPlanGate({ client, state: {} });
    expect(outcome).toEqual({
      kind: "decided",
      label: "needs_revision",
      confidence: 0.85,
      notes: "missing AC",
    });
    expect(applyPlanGate(outcome)).toEqual({
      action: "revise",
      source: "plan_gate",
      label: "needs_revision",
      confidence: 0.85,
      notes: "missing AC",
    });
  });

  it("escalates needs_human", async () => {
    const client = createJevClient({
      env: { OPTIO_NEW_JEV_BASE_URL: "https://jev.test" },
      fetchImpl: async () =>
        jsonResponse({
          answers: { plan: { choice: "needs_human", confidence: 0.9 } },
        }),
    });
    const outcome = await runPlanGate({ client, state: {} });
    expect(outcome).toEqual({
      kind: "escalate",
      label: "needs_human",
      confidence: 0.9,
    });
    expect(applyPlanGate(outcome)).toEqual({
      action: "escalate",
      source: "plan_gate",
      reason: "needs_human",
      confidence: 0.9,
    });
  });

  it("soft timeout maps to proceed via passthrough source", async () => {
    const fetchImpl: JevFetchLike = async () =>
      new Promise(() => {
        /* hang */
      });
    const client = createJevClient({
      env: { OPTIO_NEW_JEV_BASE_URL: "https://jev.test" },
      timeoutMs: 20,
      fetchImpl,
    });

    const outcome = await runPlanGate({
      client,
      state: { task_id: "t-timeout" },
      config: { timeoutMs: 20, passthroughOnTimeout: true },
    });
    expect(outcome).toMatchObject({ kind: "passthrough", reason: "timeout" });
    expect(applyPlanGate(outcome)).toMatchObject({
      action: "proceed",
      source: "passthrough",
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

    const outcome = await runPlanGate({
      client,
      state: {},
      config: { timeoutMs: 20, passthroughOnTimeout: false },
    });
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.reason).toBe("timeout");
    }
    expect(() => applyPlanGate(outcome)).toThrow(PlanGateTimeoutError);
  });

  it("passthrough on low confidence keeps notes", async () => {
    const client = createJevClient({
      env: { OPTIO_NEW_JEV_BASE_URL: "https://jev.test" },
      fetchImpl: async () =>
        jsonResponse({
          answers: {
            plan: { choice: "auto_clear", confidence: 0.4, notes: "thin plan" },
          },
        }),
    });

    const outcome = await runPlanGate({
      client,
      state: {},
      config: { minConfidence: 0.7 },
    });
    expect(outcome).toEqual({
      kind: "passthrough",
      reason: "low_confidence",
      confidence: 0.4,
      notes: "thin plan",
    });
    expect(applyPlanGate(outcome)).toEqual({
      action: "proceed",
      source: "passthrough",
      reason: "low_confidence",
      confidence: 0.4,
      notes: "thin plan",
    });
  });

  it("passthrough undecided when answer missing", async () => {
    const client = createJevClient({
      env: { OPTIO_NEW_JEV_BASE_URL: "https://jev.test" },
      fetchImpl: async () => jsonResponse({ answers: {} }),
    });
    await expect(runPlanGate({ client, state: {} })).resolves.toEqual({
      kind: "passthrough",
      reason: "undecided",
    });
  });

  it("passthrough on HTTP errors preserves status", async () => {
    const client = createJevClient({
      env: { OPTIO_NEW_JEV_BASE_URL: "https://jev.test" },
      fetchImpl: async () => jsonResponse({ error: "nope" }, 503),
    });
    const outcome = await runPlanGate({ client, state: {} });
    expect(outcome).toEqual({ kind: "passthrough", reason: "http", status: 503 });
  });
});

describe("evaluatePlanWithGate (opt-in)", () => {
  it("runs gate, maps auto_clear to proceed, and logs task_type + outcome", async () => {
    const logs: PlanGateLogEntry[] = [];
    const client = createJevClient({
      env: { OPTIO_NEW_JEV_BASE_URL: "https://jev.test" },
      fetchImpl: async () =>
        jsonResponse({
          answers: { plan: { choice: "auto_clear", confidence: 0.91 } },
        }),
    });

    const decision = await evaluatePlanWithGate({
      client,
      state: { task_id: "t1", task_type: "bugfix", plan_text: "patch null check" },
      onLog: (entry) => logs.push(entry),
    });

    expect(decision).toEqual({
      action: "proceed",
      source: "plan_gate",
      label: "auto_clear",
      confidence: 0.91,
    });
    expect(logs).toEqual([
      {
        task_type: "bugfix",
        outcome: "proceed",
        label: "auto_clear",
        confidence: 0.91,
      },
    ]);
  });

  it("logs soft passthrough as proceed decision with passthrough log outcome", async () => {
    const onLog = vi.fn();
    const client = createJevClient({
      env: { OPTIO_NEW_JEV_BASE_URL: "https://jev.test" },
      fetchImpl: async () => jsonResponse({ answers: {} }),
    });

    const decision = await evaluatePlanWithGate({
      client,
      state: { task_type: "feature" },
      onLog,
    });
    expect(decision).toEqual({
      action: "proceed",
      source: "passthrough",
      reason: "undecided",
    });
    expect(onLog).toHaveBeenCalledWith({
      task_type: "feature",
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
      evaluatePlanWithGate({
        client,
        state: { task_type: "chore" },
        config: { timeoutMs: 20, passthroughOnTimeout: false },
        onLog,
      }),
    ).rejects.toBeInstanceOf(PlanGateTimeoutError);

    expect(onLog).toHaveBeenCalledWith(
      expect.objectContaining({
        task_type: "chore",
        outcome: "error",
        reason: "timeout",
      }),
    );
  });
});
