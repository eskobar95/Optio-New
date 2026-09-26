import { HOP2_MODEL_IDS } from "./models.js";
import type { QuotaSnapshot, RoutingDecision, RoutingState } from "./types.js";

function remaining(
  snapshot: QuotaSnapshot | undefined,
  key: keyof QuotaSnapshot,
): number | undefined {
  if (!snapshot) return undefined;
  const value = snapshot[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
}

/**
 * Shared Hop 2 rules. `rules` fails closed when the snapshot is missing.
 * `poorjev` is the local fallback and picks the subscription example model instead.
 * Budget exhaustion is a hard deny and wins over a cache hit.
 */
export function decideDeterministic(
  state: RoutingState,
  mode: "rules" | "poorjev",
): RoutingDecision {
  const quota = state.quota_snapshot;
  if (quota?.budget_exhausted === true) {
    return { choice: "deny", reason: "budget_exhausted" };
  }

  const hash = typeof state.prompt_hash === "string" ? state.prompt_hash : "";
  const cached = Array.isArray(state.cached_prompt_hashes)
    ? state.cached_prompt_hashes.filter((item): item is string => typeof item === "string")
    : [];
  if (hash.length > 0 && cached.includes(hash)) {
    return { choice: "cache", model_id: HOP2_MODEL_IDS.cache, reason: "exact_prompt" };
  }

  const subscription = remaining(quota, "subscription_remaining");
  const alt = remaining(quota, "alt_remaining");
  if (subscription === undefined && alt === undefined) {
    if (mode === "poorjev") {
      return {
        choice: "subscription_pool",
        model_id: HOP2_MODEL_IDS.subscription_pool,
        reason: "poorjev_default",
      };
    }
    return { choice: "deny", reason: "ambiguous" };
  }

  if ((subscription ?? 0) > 0) {
    return {
      choice: "subscription_pool",
      model_id: HOP2_MODEL_IDS.subscription_pool,
      reason: "subscription_quota",
    };
  }
  if ((alt ?? 0) > 0) {
    return { choice: "alt_api", model_id: HOP2_MODEL_IDS.alt_api, reason: "alt_quota" };
  }
  return { choice: "deny", reason: "budget_exhausted" };
}
