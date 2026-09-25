/** Optio-New JevRouter plugin interface (SPEC §14.3). */

export type RoutingChoice = "subscription_pool" | "alt_api" | "cache" | "deny";

export interface RoutingState {
  step_id?: string;
  workflow_id?: string;
  task_id?: string;
  quota_snapshot?: Record<string, unknown>;
  prompt_hash?: string;
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
