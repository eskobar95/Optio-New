import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_INTAKE_TRIAGE_MIN_CONFIDENCE,
  PINNED_JEV_MODEL,
  IntakeTriageLabelSchema,
  IntakeTriageTimeoutError,
  applyIntakeTriage,
  createJevClient,
  evaluateIntakeTriageWithGate,
  runIntakeTriageGate,
  type IntakeTriageLogEntry,
  type JevFetchLike,
} from "../src/index.js";

function jsonResponse(body: unknown, status = 200): Awaited<ReturnType<JevFetchLike>> {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe("IntakeTriage contracts", () => {
  it("defaults minConfidence to 0.7", () => {
    expect(DEFAULT_INTAKE_TRIAGE_MIN_CONFIDENCE).toBe(0.7);
  });

  it("parses intake triage labels", () => {
    expect(IntakeTriageLabelSchema.parse("enqueue")).toBe("enqueue");
    expect(IntakeTriageLabelSchema.parse("clarify")).toBe("clarify");
    expect(IntakeTriageLabelSchema.parse("reject")).toBe("reject");
    expect(IntakeTriageLabelSchema.parse("needs_human")).toBe("needs_human");
  });
});

describe("runIntakeTriageGate", () => {
  it("returns decided enqueue on high confidence and pins jev-1.13.0", async () => {
    const fetchImpl: JevFetchLike = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        model?: string;
        questions?: { intake?: unknown };
      };
      expect(body.model).toBe(PINNED_JEV_MODEL);
      expect(body.questions?.intake).toBeTruthy();
      return jsonResponse({
        answers: { intake: { choice: "enqueue", confidence: 0.93, labels: ["bug"] } },
      });
    };
    const client = createJevClient({
      env: { OPTIO_NEW_JEV_BASE_URL: "https://jev.test" },
      fetchImpl,
    });

    const outcome = await runIntakeTriageGate({
      client,
      state: { task_id: "lin-ENG-1", issue_title: "Fix typo" },
    });
    expect(outcome).toEqual({
      kind: "decided",
      label: "enqueue",
      confidence: 0.93,
      labels: ["bug"],
    });
    expect(applyIntakeTriage(outcome)).toEqual({
      action: "enqueue",
      source: "intake_triage",
      label: "enqueue",
      confidence: 0.93,
      labels: ["bug"],
    });
  });

  it("maps clarify and reject", async () => {
    for (const label of ["clarify", "reject"] as const) {
      const client = createJevClient({
        env: { OPTIO_NEW_JEV_BASE_URL: "https://jev.test" },
        fetchImpl: async () =>
          jsonResponse({
            answers: { intake: { choice: label, confidence: 0.85, notes: "thin" } },
          }),
      });
      const outcome = await runIntakeTriageGate({ client, state: {} });
      expect(outcome).toEqual({
        kind: "decided",
        label,
        confidence: 0.85,
        notes: "thin",
      });
      expect(applyIntakeTriage(outcome)).toEqual({
        action: label,
        source: "intake_triage",
        label,
        confidence: 0.85,
        notes: "thin",
      });
    }
  });

  it("escalates needs_human", async () => {
    const client = createJevClient({
      env: { OPTIO_NEW_JEV_BASE_URL: "https://jev.test" },
      fetchImpl: async () =>
        jsonResponse({
          answers: { intake: { choice: "needs_human", confidence: 0.9 } },
        }),
    });
    const outcome = await runIntakeTriageGate({ client, state: {} });
    expect(applyIntakeTriage(outcome)).toEqual({
      action: "escalate",
      source: "intake_triage",
      reason: "needs_human",
      confidence: 0.9,
    });
  });

  it("soft timeout maps to enqueue via passthrough source", async () => {
    const fetchImpl: JevFetchLike = async () =>
      new Promise(() => {
        /* hang */
      });
    const client = createJevClient({
      env: { OPTIO_NEW_JEV_BASE_URL: "https://jev.test" },
      timeoutMs: 20,
      fetchImpl,
    });
    const outcome = await runIntakeTriageGate({
      client,
      state: {},
      config: { timeoutMs: 20, passthroughOnTimeout: true },
    });
    expect(outcome).toMatchObject({ kind: "passthrough", reason: "timeout" });
    expect(applyIntakeTriage(outcome)).toMatchObject({
      action: "enqueue",
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
    const outcome = await runIntakeTriageGate({
      client,
      state: {},
      config: { timeoutMs: 20, passthroughOnTimeout: false },
    });
    expect(outcome.kind).toBe("error");
    expect(() => applyIntakeTriage(outcome)).toThrow(IntakeTriageTimeoutError);
  });

  it("passthrough on low confidence", async () => {
    const client = createJevClient({
      env: { OPTIO_NEW_JEV_BASE_URL: "https://jev.test" },
      fetchImpl: async () =>
        jsonResponse({
          answers: { intake: { choice: "reject", confidence: 0.2 } },
        }),
    });
    const outcome = await runIntakeTriageGate({
      client,
      state: {},
      config: { minConfidence: 0.7 },
    });
    expect(outcome).toEqual({
      kind: "passthrough",
      reason: "low_confidence",
      confidence: 0.2,
    });
    expect(applyIntakeTriage(outcome)).toMatchObject({
      action: "enqueue",
      source: "passthrough",
      reason: "low_confidence",
    });
  });
});

describe("evaluateIntakeTriageWithGate", () => {
  it("logs enqueue decisions for feedback", async () => {
    const logs: IntakeTriageLogEntry[] = [];
    const client = createJevClient({
      env: { OPTIO_NEW_JEV_BASE_URL: "https://jev.test" },
      fetchImpl: async () =>
        jsonResponse({
          answers: { intake: { choice: "enqueue", confidence: 0.9 } },
        }),
    });
    const decision = await evaluateIntakeTriageWithGate({
      client,
      state: {
        task_id: "lin-ENG-25",
        issue_identifier: "ENG-25",
        task_type: "feature",
      },
      onLog: (entry) => logs.push(entry),
    });
    expect(decision.action).toBe("enqueue");
    expect(logs).toEqual([
      {
        task_id: "lin-ENG-25",
        task_type: "feature",
        issue_identifier: "ENG-25",
        outcome: "enqueue",
        label: "enqueue",
        confidence: 0.9,
      },
    ]);
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
      evaluateIntakeTriageWithGate({
        client,
        state: { task_id: "t-hard" },
        config: { timeoutMs: 20, passthroughOnTimeout: false },
        onLog,
      }),
    ).rejects.toBeInstanceOf(IntakeTriageTimeoutError);
    expect(onLog).toHaveBeenCalledWith(
      expect.objectContaining({ task_id: "t-hard", outcome: "error", reason: "timeout" }),
    );
  });
});
