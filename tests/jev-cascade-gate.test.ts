import { describe, expect, it } from "vitest";
import {
  applyBackendCascade,
  BackendCascadeLabelSchema,
  BackendCascadeTimeoutError,
  createJevClient,
  JEV_GATE_SEQUENCE,
  mapCascadeLabelToTarget,
  PINNED_JEV_MODEL,
  resolveCodingBackendWithCascade,
  runBackendCascadeGate,
  type JevFetchLike,
} from "../src/index.js";

function jsonResponse(body: unknown, status = 200): Awaited<ReturnType<JevFetchLike>> {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

const okFetch: JevFetchLike = async () => jsonResponse({});

describe("Jev gate sequence contracts", () => {
  it("documents the ordered five-gate sequence", () => {
    expect(JEV_GATE_SEQUENCE).toEqual([
      "backend_cascade",
      "plan",
      "skill_pick",
      "review_prescreen",
      "intake",
    ]);
  });

  it("pins jev-1.13.0 on the shared client", () => {
    const client = createJevClient({ env: {}, fetchImpl: okFetch });
    expect(client.model).toBe(PINNED_JEV_MODEL);
    expect(PINNED_JEV_MODEL).toBe("jev-1.13.0");
  });

  it("maps cascade labels to flue | cursor tiers", () => {
    expect(mapCascadeLabelToTarget("flue_cheap")).toEqual({ backend: "flue" });
    expect(mapCascadeLabelToTarget("cursor_composer")).toEqual({
      backend: "cursor",
      modelTier: "composer",
    });
    expect(mapCascadeLabelToTarget("cursor_frontier")).toEqual({
      backend: "cursor",
      modelTier: "frontier",
    });
    expect(BackendCascadeLabelSchema.parse("needs_human")).toBe("needs_human");
  });
});

describe("createJevClient timeout", () => {
  it("times out via Promise.race when fetchImpl ignores signal", async () => {
    const fetchImpl: JevFetchLike = async () =>
      new Promise(() => {
        /* never resolves, ignores signal */
      });
    const client = createJevClient({
      env: { OPTIO_NEW_JEV_BASE_URL: "https://jev.test" },
      timeoutMs: 25,
      fetchImpl,
    });
    const result = await client.postSystemOne({
      state: {},
      questions: {},
      timeoutMs: 25,
    });
    expect(result).toMatchObject({ ok: false, reason: "timeout" });
  });

  it("returns invalid_body when JSON parse fails", async () => {
    const fetchImpl: JevFetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("bad json");
      },
    });
    const client = createJevClient({
      env: { OPTIO_NEW_JEV_BASE_URL: "https://jev.test" },
      fetchImpl,
    });
    await expect(client.postSystemOne({ state: {}, questions: {} })).resolves.toEqual({
      ok: false,
      reason: "invalid_body",
      status: 200,
      message: "bad json",
    });
  });
});

describe("runBackendCascadeGate", () => {
  it("returns decided flue_cheap on high confidence", async () => {
    const fetchImpl: JevFetchLike = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        model?: string;
        questions?: { backend_cascade?: unknown };
      };
      expect(body.model).toBe("jev-1.13.0");
      expect(body.questions?.backend_cascade).toBeTruthy();
      return jsonResponse({
        answers: { backend_cascade: { choice: "flue_cheap", confidence: 0.91 } },
      });
    };
    const client = createJevClient({
      env: { OPTIO_NEW_JEV_BASE_URL: "https://jev.test" },
      fetchImpl,
    });

    const outcome = await runBackendCascadeGate({
      client,
      state: { task_id: "t1", issue_title: "typo fix" },
    });
    expect(outcome).toEqual({
      kind: "decided",
      label: "flue_cheap",
      confidence: 0.91,
      target: { backend: "flue" },
    });
  });

  it("passthrough on timeout (soft gate fail-open)", async () => {
    const fetchImpl: JevFetchLike = async () =>
      new Promise(() => {
        /* hang */
      });
    const client = createJevClient({
      env: { OPTIO_NEW_JEV_BASE_URL: "https://jev.test" },
      timeoutMs: 20,
      fetchImpl,
    });

    const outcome = await runBackendCascadeGate({
      client,
      state: { task_id: "t-timeout" },
      config: { timeoutMs: 20, passthroughOnTimeout: true },
    });
    expect(outcome).toMatchObject({ kind: "passthrough", reason: "timeout" });
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

    const outcome = await runBackendCascadeGate({
      client,
      state: {},
      config: { timeoutMs: 20, passthroughOnTimeout: false },
    });
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.reason).toBe("timeout");
    }
    expect(() => applyBackendCascade({ defaultBackend: "cursor" }, outcome)).toThrow(
      BackendCascadeTimeoutError,
    );
  });

  it("passthrough on low confidence", async () => {
    const client = createJevClient({
      env: { OPTIO_NEW_JEV_BASE_URL: "https://jev.test" },
      fetchImpl: async () =>
        jsonResponse({
          answers: { backend_cascade: { choice: "cursor_frontier", confidence: 0.4 } },
        }),
    });

    const outcome = await runBackendCascadeGate({
      client,
      state: {},
      config: { minConfidence: 0.7 },
    });
    expect(outcome).toEqual({
      kind: "passthrough",
      reason: "low_confidence",
      confidence: 0.4,
    });
  });

  it("passthrough undecided when answer missing", async () => {
    const client = createJevClient({
      env: { OPTIO_NEW_JEV_BASE_URL: "https://jev.test" },
      fetchImpl: async () => jsonResponse({ answers: {} }),
    });
    await expect(runBackendCascadeGate({ client, state: {} })).resolves.toEqual({
      kind: "passthrough",
      reason: "undecided",
    });
  });

  it("escalates needs_human without picking a backend", async () => {
    const client = createJevClient({
      env: { OPTIO_NEW_JEV_BASE_URL: "https://jev.test" },
      fetchImpl: async () =>
        jsonResponse({
          answers: { backend_cascade: { choice: "needs_human", confidence: 0.88 } },
        }),
    });

    const outcome = await runBackendCascadeGate({ client, state: {} });
    expect(outcome).toEqual({
      kind: "escalate",
      label: "needs_human",
      confidence: 0.88,
    });
  });

  it("passthrough on HTTP errors preserves status", async () => {
    const client = createJevClient({
      env: { OPTIO_NEW_JEV_BASE_URL: "https://jev.test" },
      fetchImpl: async () => jsonResponse({ error: "nope" }, 503),
    });
    const outcome = await runBackendCascadeGate({ client, state: {} });
    expect(outcome).toEqual({ kind: "passthrough", reason: "http", status: 503 });
  });
});

describe("resolveCodingBackendWithCascade (opt-in)", () => {
  it("runs gate then maps flue_cheap to flue", async () => {
    const client = createJevClient({
      env: { OPTIO_NEW_JEV_BASE_URL: "https://jev.test" },
      fetchImpl: async () =>
        jsonResponse({
          answers: { backend_cascade: { choice: "flue_cheap", confidence: 0.9 } },
        }),
    });
    const decision = await resolveCodingBackendWithCascade(
      { defaultBackend: "cursor" },
      { client, state: { task_id: "t1" } },
    );
    expect(decision).toEqual({
      kind: "backend",
      backend: "flue",
      source: "cascade",
      confidence: 0.9,
      label: "flue_cheap",
    });
  });

  it("passthrough falls back to deterministic coding_backend", () => {
    const decision = applyBackendCascade(
      { defaultBackend: "cursor" },
      { kind: "passthrough", reason: "timeout" },
    );
    expect(decision).toEqual({
      kind: "backend",
      backend: "cursor",
      source: "passthrough",
    });
  });

  it("escalates needs_human", () => {
    const decision = applyBackendCascade(
      { defaultBackend: "cursor" },
      { kind: "escalate", label: "needs_human", confidence: 0.95 },
    );
    expect(decision).toEqual({
      kind: "escalate",
      reason: "needs_human",
      confidence: 0.95,
    });
  });

  it("keeps cursor model tiers on cascade composer/frontier", () => {
    expect(
      applyBackendCascade(
        { defaultBackend: "codex" },
        {
          kind: "decided",
          label: "cursor_composer",
          confidence: 0.8,
          target: { backend: "cursor", modelTier: "composer" },
        },
      ),
    ).toMatchObject({
      kind: "backend",
      backend: "cursor",
      modelTier: "composer",
      source: "cascade",
    });
  });
});
