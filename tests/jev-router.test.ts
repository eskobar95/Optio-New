import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyHop2Decision,
  createJevRouter,
  createLayaRouter,
  loadConfiguredHop2Router,
  loadHop2Router,
  resolveJevBaseUrl,
  resolveLayaBaseUrl,
  type CachedCompletion,
  type FetchLike,
} from "../src/index.js";

const VERCEL_AI_GATEWAY = "https://ai-gateway.vercel.sh";

const storedCompletion: CachedCompletion = {
  id: "chatcmpl-cache-1",
  object: "chat.completion",
  choices: [
    {
      message: { role: "assistant", content: "stored-answer" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
};

function cacheOf(hash: string, completion: CachedCompletion | undefined) {
  return {
    get(promptHash: string) {
      return promptHash === hash ? completion : undefined;
    },
  };
}

function jsonResponse(body: unknown, status = 200): Awaited<ReturnType<FetchLike>> {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe("Jev base URL", () => {
  it("defaults to the Vercel AI Gateway", () => {
    expect(resolveJevBaseUrl({})).toBe(VERCEL_AI_GATEWAY);
  });

  it("prefers OPTIO_NEW_JEV_BASE_URL over the aliases", () => {
    expect(
      resolveJevBaseUrl({
        OPTIO_NEW_JEV_BASE_URL: "https://jev.example",
        JEV_BASE_URL: "https://alias.example",
        VERCEL_AI_GATEWAY_URL: "https://gateway.example",
      }),
    ).toBe("https://jev.example");
  });

  it("accepts JEV_BASE_URL when the OPTIO_NEW_ override is absent", () => {
    expect(resolveJevBaseUrl({ JEV_BASE_URL: "https://from-jev-base.example" })).toBe(
      "https://from-jev-base.example",
    );
  });
});

describe("Hop 2 plugin swap", () => {
  it("loads jev, poorjev, laya, and rules without the Codex adapter importing a plugin", () => {
    for (const id of ["jev", "poorjev", "laya", "rules"] as const) {
      expect(
        typeof loadHop2Router(id, { env: {}, fetchImpl: async () => jsonResponse({}) }).decide,
      ).toBe("function");
    }
    expect(() => loadHop2Router("typesafe")).toThrow(/unknown JevRouter plugin: typesafe/);

    const codex = readFileSync("src/adapters/codex/index.ts", "utf8");
    const cursor = readFileSync("src/adapters/cursor/index.ts", "utf8");
    expect(codex).not.toContain("jev-router/plugins");
    expect(cursor).not.toContain("jev-router/plugins");
  });

  it("fails closed when OPTIO_NEW_JEV_ROUTER is unset", () => {
    expect(() => loadConfiguredHop2Router({})).toThrow(/OPTIO_NEW_JEV_ROUTER is unset/);
  });

  it("uses the configured plugin id", async () => {
    const router = loadConfiguredHop2Router({ OPTIO_NEW_JEV_ROUTER: "rules" });
    await expect(router.decide({})).resolves.toEqual({ choice: "deny", reason: "ambiguous" });
  });
});

describe("rules router", () => {
  const rules = loadHop2Router("rules");

  it("denies when the quota snapshot is missing", async () => {
    await expect(rules.decide({ task_id: "t-1" })).resolves.toEqual({
      choice: "deny",
      reason: "ambiguous",
    });
  });

  it("denies when the budget is exhausted even if the prompt is cached", async () => {
    await expect(
      rules.decide({
        prompt_hash: "abc",
        cached_prompt_hashes: ["abc"],
        quota_snapshot: { budget_exhausted: true, subscription_remaining: 10 },
      }),
    ).resolves.toEqual({ choice: "deny", reason: "budget_exhausted" });
  });

  it("returns cache for an exact prompt hash while subscription quota remains", async () => {
    await expect(
      rules.decide({
        prompt_hash: "abc",
        cached_prompt_hashes: ["other", "abc"],
        quota_snapshot: { subscription_remaining: 4 },
      }),
    ).resolves.toEqual({
      choice: "cache",
      model_id: "cache-exact",
      reason: "exact_prompt",
    });
  });

  it("picks the subscription example model when quota remains and nothing is cached", async () => {
    await expect(
      rules.decide({ quota_snapshot: { subscription_remaining: 2, alt_remaining: 9 } }),
    ).resolves.toEqual({
      choice: "subscription_pool",
      model_id: "gpt-4o",
      reason: "subscription_quota",
    });
  });

  it("picks the alt example model when subscription quota is gone", async () => {
    await expect(
      rules.decide({ quota_snapshot: { subscription_remaining: 0, alt_remaining: 3 } }),
    ).resolves.toEqual({
      choice: "alt_api",
      model_id: "claude-sonnet",
      reason: "alt_quota",
    });
  });

  it("denies when both quotas are zero", async () => {
    await expect(
      rules.decide({ quota_snapshot: { subscription_remaining: 0, alt_remaining: 0 } }),
    ).resolves.toEqual({ choice: "deny", reason: "budget_exhausted" });
  });
});

describe("poorjev router", () => {
  const poorjev = loadHop2Router("poorjev");

  it("defaults to the subscription pool when the snapshot is missing", async () => {
    await expect(poorjev.decide({})).resolves.toEqual({
      choice: "subscription_pool",
      model_id: "gpt-4o",
      reason: "poorjev_default",
    });
  });

  it("still denies an exhausted budget and still serves an exact cache hit", async () => {
    await expect(poorjev.decide({ quota_snapshot: { budget_exhausted: true } })).resolves.toEqual({
      choice: "deny",
      reason: "budget_exhausted",
    });
    await expect(
      poorjev.decide({
        prompt_hash: "abc",
        cached_prompt_hashes: ["abc"],
        quota_snapshot: { subscription_remaining: 1 },
      }),
    ).resolves.toEqual({
      choice: "cache",
      model_id: "cache-exact",
      reason: "exact_prompt",
    });
  });
});

describe("jev and laya systemone", () => {
  it("posts Hop 2 to the Vercel AI Gateway /v1/systemone path", async () => {
    let url = "";
    let body: unknown;
    const router = createJevRouter({
      env: {},
      fetchImpl: async (input, init) => {
        url = input;
        body = JSON.parse(init?.body ?? "{}");
        return jsonResponse({
          model: "jev-1.13.0",
          answers: {
            hop2: {
              type: "choice",
              choice: "alt_api",
              confidence: 0.8,
              probabilities: { alt_api: 0.8 },
            },
          },
          usage: { input_tokens: 12, output_tokens: 0 },
        });
      },
    });

    await expect(router.decide({ task_id: "t-9", prompt_hash: "h" })).resolves.toEqual({
      choice: "alt_api",
      model_id: "claude-sonnet",
      reason: "systemone",
      confidence: 0.8,
    });
    expect(url).toBe(`${VERCEL_AI_GATEWAY}/v1/systemone`);
    expect(body).toMatchObject({
      model: "jev-latest",
      state: { task_id: "t-9", prompt_hash: "h" },
      questions: {
        hop2: {
          type: "choice",
          criteria: {
            subscription_pool: expect.any(String),
            alt_api: expect.any(String),
            cache: expect.any(String),
            deny: expect.any(String),
          },
        },
      },
    });
  });

  it("sends the bearer token only when OPTIO_NEW_JEV_API_KEY is set", async () => {
    const headers: Record<string, string>[] = [];
    const fetchImpl: FetchLike = async (_input, init) => {
      headers.push(init?.headers ?? {});
      return jsonResponse({
        answers: { hop2: { type: "choice", choice: "deny", confidence: 1 } },
      });
    };
    await createJevRouter({ env: {}, fetchImpl }).decide({});
    await createJevRouter({
      env: { OPTIO_NEW_JEV_API_KEY: "test-key" },
      fetchImpl,
    }).decide({});
    expect(headers[0]?.authorization).toBeUndefined();
    expect(headers[1]?.authorization).toBe("Bearer test-key");
  });

  it("fails closed when the gateway is unreachable, non-OK, or undecided", async () => {
    const unreachable = createJevRouter({
      env: { JEV_BASE_URL: "https://jev.example" },
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });
    await expect(unreachable.decide({})).resolves.toEqual({
      choice: "deny",
      reason: "upstream_unreachable",
    });

    const http = createJevRouter({
      env: {},
      fetchImpl: async () => jsonResponse({ error: "nope" }, 503),
    });
    await expect(http.decide({})).resolves.toEqual({ choice: "deny", reason: "upstream_http" });

    const undecided = createJevRouter({
      env: {},
      fetchImpl: async () =>
        jsonResponse({ answers: { hop2: { type: "choice", choice: "banana" } } }),
    });
    await expect(undecided.decide({})).resolves.toEqual({ choice: "deny", reason: "undecided" });
  });

  it("posts laya at LAYA_URL /v1/systemone and omits a hosted model id", async () => {
    expect(resolveLayaBaseUrl({})).toBe("http://127.0.0.1:8000");
    let url = "";
    let body: { model?: string } = {};
    const router = createLayaRouter({
      env: { OPTIO_NEW_LAYA_URL: "http://127.0.0.1:8000" },
      fetchImpl: async (input, init) => {
        url = input;
        body = JSON.parse(init?.body ?? "{}") as { model?: string };
        return jsonResponse({
          answers: { hop2: { type: "choice", choice: "cache", confidence: 0.66 } },
        });
      },
    });
    await expect(router.decide({ prompt_hash: "abc" })).resolves.toEqual({
      choice: "cache",
      model_id: "cache-exact",
      reason: "systemone",
      confidence: 0.66,
    });
    expect(url).toBe("http://127.0.0.1:8000/v1/systemone");
    expect(body.model).toBeUndefined();
  });
});

describe("Hop 2 cache and deny", () => {
  it("returns the stored completion with zero upstream tokens", () => {
    const result = applyHop2Decision(
      { choice: "cache", model_id: "cache-exact", reason: "exact_prompt" },
      { prompt_hash: "hash-1" },
      cacheOf("hash-1", storedCompletion),
    );
    expect(result).toEqual({
      kind: "cache",
      route: "cache",
      httpStatus: 200,
      body: storedCompletion,
      upstreamTokens: 0,
      model_id: "cache-exact",
    });
    if (result.kind === "cache") {
      expect(result.body).toBe(storedCompletion);
    }
  });

  it("maps budget exhaustion to HTTP 429 and budget_exhausted", () => {
    expect(
      applyHop2Decision(
        { choice: "deny", reason: "budget_exhausted" },
        {},
        cacheOf("hash-1", storedCompletion),
      ),
    ).toEqual({
      kind: "deny",
      route: "deny",
      httpStatus: 429,
      upstreamTokens: 0,
      codingAgentStatus: "budget_exhausted",
      body: {
        error: {
          type: "budget_exhausted",
          message: "Hop 2 budget exhausted",
          code: "insufficient_quota",
        },
      },
    });
  });

  it("maps any other deny to HTTP 429 and rate_limited", () => {
    expect(
      applyHop2Decision({ choice: "deny", reason: "ambiguous" }, {}, cacheOf("", undefined)),
    ).toEqual({
      kind: "deny",
      route: "deny",
      httpStatus: 429,
      upstreamTokens: 0,
      codingAgentStatus: "rate_limited",
      body: {
        error: {
          type: "rate_limited",
          message: "Hop 2 denied",
          code: "insufficient_quota",
        },
      },
    });
  });

  it("denies a cache decision that has no stored completion", () => {
    const result = applyHop2Decision(
      { choice: "cache", reason: "exact_prompt" },
      { prompt_hash: "missing" },
      cacheOf("other", storedCompletion),
    );
    expect(result.kind).toBe("deny");
    if (result.kind === "deny") {
      expect(result.httpStatus).toBe(429);
      expect(result.codingAgentStatus).toBe("rate_limited");
    }
  });

  it("forwards subscription and alt decisions to the example model ids", () => {
    expect(
      applyHop2Decision(
        { choice: "subscription_pool", model_id: "gpt-4o", reason: "subscription_quota" },
        {},
        cacheOf("", undefined),
      ),
    ).toEqual({
      kind: "forward",
      route: "subscription_pool",
      model_id: "gpt-4o",
    });
    expect(
      applyHop2Decision({ choice: "alt_api", reason: "alt_quota" }, {}, cacheOf("", undefined)),
    ).toEqual({
      kind: "forward",
      route: "alt_api",
      model_id: "claude-sonnet",
    });
  });
});

describe("Jev docs", () => {
  it("documents JEV_BASE_URL as the Vercel AI Gateway", () => {
    const readme = readFileSync("gateway/jev-router/README.md", "utf8");
    const root = readFileSync("README.md", "utf8");
    expect(readme).toContain("JEV_BASE_URL");
    expect(readme).toContain(VERCEL_AI_GATEWAY);
    expect(readme).not.toContain("api.typesafe.ai");
    expect(root).toContain(VERCEL_AI_GATEWAY);
  });
});
