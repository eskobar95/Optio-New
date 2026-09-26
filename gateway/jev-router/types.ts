/** Optio-New JevRouter plugin interface (SPEC §14.3). */

export type RoutingChoice = "subscription_pool" | "alt_api" | "cache" | "deny";

export interface QuotaSnapshot {
  subscription_remaining?: number;
  alt_remaining?: number;
  budget_exhausted?: boolean;
  [key: string]: unknown;
}

export interface RoutingState {
  step_id?: string;
  workflow_id?: string;
  task_id?: string;
  quota_snapshot?: QuotaSnapshot;
  prompt_hash?: string;
  /** Exact-prompt hashes already stored for Hop 2 cache. */
  cached_prompt_hashes?: string[];
  [key: string]: unknown;
}

export interface RoutingDecision {
  choice: RoutingChoice;
  model_id?: string;
  reason?: string;
  confidence?: number;
}

export interface JevRouter {
  decide(state: RoutingState): Promise<RoutingDecision>;
}
