import type { RoutingChoice } from "./types.js";

/** Example model_name values in gateway/litellm/config.yaml.example. */
export const HOP2_MODEL_IDS = {
  subscription_pool: "gpt-4o",
  alt_api: "claude-sonnet",
  cache: "cache-exact",
} as const;

export function isRoutingChoice(value: unknown): value is RoutingChoice {
  return (
    value === "subscription_pool" || value === "alt_api" || value === "cache" || value === "deny"
  );
}
