import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_REVIEW_PRESCREEN_MIN_CONFIDENCE,
  PINNED_JEV_MODEL,
  ReviewPrescreenLabelSchema,
  ReviewPrescreenTimeoutError,
  applyReviewPrescreen,
  createJevClient,
  evaluateReviewPrescreenWithGate,
  runReviewPrescreenGate,
  type JevFetchLike,
  type ReviewPrescreenLogEntry,
} from "../src/index.js";

function jsonResponse(body: unknown, status = 200): Awaited<ReturnType<JevFetchLike>> {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe("ReviewPrescreen contracts", () => {
  it("defaults minConfidence to 0.7", () => {
    expect(DEFAULT_REVIEW_PRESCREEN_MIN_CONFIDENCE).toBe(0.7);
  });

  it("parses review pre-screen labels", () => {
    expect(ReviewPrescreenLabelSchema.parse("forward")).toBe("forward");
    expect(ReviewPrescreenLabelSchema.parse("filter")).toBe("filter");
    expect(ReviewPrescreenLabelSchema.parse("needs_human")).toBe("needs_human");
  });
});

describe("runReviewPrescreenGate", () => {
  it("returns decided forward on high confidence and pins jev-1.13.0", async () => {
    const fetchImpl: JevFetchLike = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        model?: string;
        questions?: { review_prescreen?: unknown };
      };
      expect(body.model).toBe(PINNED_JEV_MODEL);
      expect(body.questions?.review_prescreen).toBeTruthy();
      return jsonResponse({
        answers: { review_prescreen: { choice: "forward", confidence: 0.91 } },
      });
    };
    const client = createJevClient({
      env: { OPTIO_NEW_JEV_BASE_URL: "https://jev.test" },
      fetchImpl,
    });

    const paths = ["src/a.ts", "src/b.ts"];
    const outcome = await runReviewPrescreenGate({
      client,
      state: { task_id: "t1", diff_paths: paths },
    });
    expect(outcome).toEqual({
      kind: "decided",
      label: "forward",
      confidence: 0.91,
    });
    expect(applyReviewPrescreen(outcome, paths)).toEqual({
      action: "forward",
      source: "review_prescreen",
      label: "forward",
      confidence: 0.91,
      paths,
    });
  });

  it("filters paths to the diff registry", async () => {
    const client = createJevClient({
      env: { OPTIO_NEW_JEV_BASE_URL: "https://jev.test" },
      fetchImpl: async () =>
        jsonResponse({
          answers: {
            review_prescreen: {
              choice: "filter",
              confidence: 0.88,
              filtered_paths: ["src/a.ts", "evil.ts", "src/a.ts"],
            },
          },
        }),
    });
    const paths = ["src/a.ts", "src/b.ts"];
    const outcome = await runReviewPrescreenGate({
      client,
      state: { diff_paths: paths },
    });
    expect(outcome).toEqual({
      kind: "decided",
      label: "filter",
      confidence: 0.88,
      filteredPaths: ["src/a.ts"],
    });
    expect(applyReviewPrescreen(outcome, paths)).toEqual({
      action: "filter",
      source: "review_prescreen",
      label: "filter",
      confidence: 0.88,
      paths: ["src/a.ts"],
    });
  });

  it("escalates needs_human", async () => {
    const client = createJevClient({
      env: { OPTIO_NEW_JEV_BASE_URL: "https://jev.test" },
      fetchImpl: async () =>
        jsonResponse({
          answers: { review_prescreen: { choice: "needs_human", confidence: 0.9 } },
        }),
    });
    const outcome = await runReviewPrescreenGate({ client, state: { diff_paths: ["a.ts"] } });
    expect(outcome).toEqual({
      kind: "escalate",
      label: "needs_human",
      confidence: 0.9,
    });
    expect(applyReviewPrescreen(outcome, ["a.ts"])).toEqual({
      action: "escalate",
      source: "review_prescreen",
      reason: "needs_human",
      confidence: 0.9,
      paths: ["a.ts"],
    });
  });

  it("soft timeout maps to forward via passthrough source", async () => {
    const fetchImpl: JevFetchLike = async () =>
      new Promise(() => {
        /* hang */
      });
    const client = createJevClient({
      env: { OPTIO_NEW_JEV_BASE_URL: "https://jev.test" },
      timeoutMs: 20,
      fetchImpl,
    });
    const paths = ["a.ts"];
    const outcome = await runReviewPrescreenGate({
      client,
      state: { diff_paths: paths },
      config: { timeoutMs: 20, passthroughOnTimeout: true },
    });
    expect(outcome).toMatchObject({ kind: "passthrough", reason: "timeout" });
    expect(applyReviewPrescreen(outcome, paths)).toMatchObject({
      action: "forward",
      source: "passthrough",
      reason: "timeout",
      paths,
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
    const outcome = await runReviewPrescreenGate({
      client,
      state: {},
      config: { timeoutMs: 20, passthroughOnTimeout: false },
    });
    expect(outcome.kind).toBe("error");
    expect(() => applyReviewPrescreen(outcome, [])).toThrow(ReviewPrescreenTimeoutError);
  });

  it("passthrough when filter yields empty registry intersection", async () => {
    const client = createJevClient({
      env: { OPTIO_NEW_JEV_BASE_URL: "https://jev.test" },
      fetchImpl: async () =>
        jsonResponse({
          answers: {
            review_prescreen: {
              choice: "filter",
              confidence: 0.95,
              filtered_paths: ["missing.ts"],
            },
          },
        }),
    });
    const outcome = await runReviewPrescreenGate({
      client,
      state: { diff_paths: ["a.ts"] },
    });
    expect(outcome).toMatchObject({ kind: "passthrough", reason: "filtered_empty" });
  });
});

describe("evaluateReviewPrescreenWithGate", () => {
  it("logs forward decisions", async () => {
    const logs: ReviewPrescreenLogEntry[] = [];
    const client = createJevClient({
      env: { OPTIO_NEW_JEV_BASE_URL: "https://jev.test" },
      fetchImpl: async () =>
        jsonResponse({
          answers: { review_prescreen: { choice: "forward", confidence: 0.9 } },
        }),
    });
    const decision = await evaluateReviewPrescreenWithGate({
      client,
      state: { task_id: "t1", task_type: "feature", diff_paths: ["a.ts"] },
      onLog: (entry) => logs.push(entry),
    });
    expect(decision.action).toBe("forward");
    expect(logs).toEqual([
      {
        task_id: "t1",
        task_type: "feature",
        outcome: "forward",
        label: "forward",
        confidence: 0.9,
        paths: ["a.ts"],
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
      evaluateReviewPrescreenWithGate({
        client,
        state: { task_id: "t-hard" },
        config: { timeoutMs: 20, passthroughOnTimeout: false },
        onLog,
      }),
    ).rejects.toBeInstanceOf(ReviewPrescreenTimeoutError);
    expect(onLog).toHaveBeenCalledWith(
      expect.objectContaining({ task_id: "t-hard", outcome: "error", reason: "timeout" }),
    );
  });
});
