import { HOP2_MODEL_IDS } from "./models.js";
import type { RoutingDecision, RoutingState } from "./types.js";

/** OpenAI chat-completion shape Codex already accepts. */
export interface CachedCompletion {
  id: string;
  object: "chat.completion";
  choices: ReadonlyArray<{
    message: { role: "assistant"; content: string };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ExactPromptCache {
  get(promptHash: string): CachedCompletion | undefined;
}

interface Hop2DenyBody {
  error: {
    type: "budget_exhausted" | "rate_limited";
    message: string;
    code: "insufficient_quota";
  };
}

export type Hop2Result =
  | {
      kind: "cache";
      route: "cache";
      httpStatus: 200;
      body: CachedCompletion;
      upstreamTokens: 0;
      model_id: "cache-exact";
    }
  | {
      kind: "deny";
      route: "deny";
      httpStatus: 429;
      upstreamTokens: 0;
      codingAgentStatus: "budget_exhausted" | "rate_limited";
      body: Hop2DenyBody;
    }
  | {
      kind: "forward";
      route: "subscription_pool" | "alt_api";
      model_id: string;
    };

function deny(reason: string): Extract<Hop2Result, { kind: "deny" }> {
  const budget = reason === "budget_exhausted";
  return {
    kind: "deny",
    route: "deny",
    httpStatus: 429,
    upstreamTokens: 0,
    codingAgentStatus: budget ? "budget_exhausted" : "rate_limited",
    body: {
      error: {
        type: budget ? "budget_exhausted" : "rate_limited",
        message: budget ? "Hop 2 budget exhausted" : "Hop 2 denied",
        code: "insufficient_quota",
      },
    },
  };
}

/**
 * Apply a Hop 2 decision before LiteLLM (SPEC §14.6).
 * Cache returns the stored completion and zero upstream tokens.
 * Deny is HTTP 429. Subscription and alt forward to an example model_name.
 */
export function applyHop2Decision(
  decision: RoutingDecision,
  state: RoutingState,
  cache: ExactPromptCache,
): Hop2Result {
  if (decision.choice === "deny") {
    return deny(decision.reason ?? "ambiguous");
  }

  if (decision.choice === "cache") {
    const hash = typeof state.prompt_hash === "string" ? state.prompt_hash : "";
    const stored = hash ? cache.get(hash) : undefined;
    if (!stored) return deny("cache_miss");
    return {
      kind: "cache",
      route: "cache",
      httpStatus: 200,
      body: stored,
      upstreamTokens: 0,
      model_id: "cache-exact",
    };
  }

  return {
    kind: "forward",
    route: decision.choice,
    model_id: decision.model_id || HOP2_MODEL_IDS[decision.choice],
  };
}
