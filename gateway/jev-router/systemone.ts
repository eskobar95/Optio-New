import { HOP2_MODEL_IDS, isRoutingChoice } from "./models.js";
import type { RoutingDecision, RoutingState } from "./types.js";

export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface SystemOneDeps {
  fetchImpl?: FetchLike;
  apiKey?: string;
  /** Omitted for Laya so the local server auto-selects a checkpoint. */
  model?: string;
}

const HOP2_QUESTION = {
  type: "choice",
  instructions:
    "Hop 2 Codex upstream. Pick one route. Deny when the quota snapshot is missing or the upstream is ambiguous.",
  criteria: {
    subscription_pool: "Subscription quota remains. Forward to the gpt-4o example model.",
    alt_api: "Subscription quota is exhausted and alt quota remains. Forward to claude-sonnet.",
    cache: "The prompt hash is in the exact-prompt cache. Serve the stored completion.",
    deny: "Budget is exhausted or the route is ambiguous. Refuse the call.",
  },
} as const;

/** Origin plus `/v1/systemone`. A base that already ends in `/v1` is not doubled. */
export function systemOneUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw new Error("empty Jev base URL");
  }
  const origin = trimmed.endsWith("/v1") ? trimmed.slice(0, -"/v1".length) : trimmed;
  return `${origin}/v1/systemone`;
}

export function decisionFromSystemOne(payload: unknown): RoutingDecision {
  if (!payload || typeof payload !== "object") {
    return { choice: "deny", reason: "undecided" };
  }
  const answers = (payload as { answers?: unknown }).answers;
  if (!answers || typeof answers !== "object") {
    return { choice: "deny", reason: "undecided" };
  }
  const hop2 = (answers as { hop2?: unknown }).hop2;
  if (!hop2 || typeof hop2 !== "object") {
    return { choice: "deny", reason: "undecided" };
  }
  const choice = (hop2 as { choice?: unknown }).choice;
  if (!isRoutingChoice(choice)) {
    return { choice: "deny", reason: "undecided" };
  }
  const confidenceValue = (hop2 as { confidence?: unknown }).confidence;
  const confidence =
    typeof confidenceValue === "number" && Number.isFinite(confidenceValue)
      ? confidenceValue
      : undefined;
  if (choice === "deny") {
    return {
      choice: "deny",
      reason: "systemone",
      ...(confidence !== undefined ? { confidence } : {}),
    };
  }
  return {
    choice,
    model_id: HOP2_MODEL_IDS[choice],
    reason: "systemone",
    ...(confidence !== undefined ? { confidence } : {}),
  };
}

/**
 * Jev wire protocol shared by the hosted `jev` plugin and local `laya`.
 * Fail closed: network, HTTP, and undecided answers become `deny` and do not throw.
 */
export async function decideViaSystemOne(
  baseUrl: string,
  state: RoutingState,
  deps: SystemOneDeps = {},
): Promise<RoutingDecision> {
  let url: string;
  try {
    url = systemOneUrl(baseUrl);
  } catch {
    return { choice: "deny", reason: "upstream_unreachable" };
  }

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (deps.apiKey) {
    headers.authorization = `Bearer ${deps.apiKey}`;
  }
  const body: Record<string, unknown> = {
    state,
    questions: { hop2: HOP2_QUESTION },
  };
  if (deps.model) {
    body.model = deps.model;
  }

  const fetchImpl = deps.fetchImpl ?? (fetch as FetchLike);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      return { choice: "deny", reason: "upstream_http" };
    }
    return decisionFromSystemOne(await response.json());
  } catch {
    return { choice: "deny", reason: "upstream_unreachable" };
  }
}
