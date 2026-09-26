/**
 * Optio-New — CodingAgent adapter interface (SPEC §13.1).
 * Adapters mutate the worktree and report; they do not own workflow, worktrees, or intake webhooks.
 */

export type CodingAgentStatus =
  "succeeded" | "failed" | "cancelled" | "budget_exhausted" | "rate_limited";

export interface CodingAgentBudget {
  maxTokens?: number;
  maxWallClockMs?: number;
  maxToolRounds?: number;
  maxUsd?: number;
}

export interface CodingAgentInput {
  worktree_path: string;
  prompt: string;
  instructions?: string;
  allowed_tools: string[];
  /**
   * Explicit ceiling. Omitted means the stage default for `metadata.step_id`
   * (`read-only` when the step is unknown). `host-admin` is never implied.
   */
  permission_tier?: "read-only" | "edit-worktree" | "git-push" | "host-admin";
  budget: CodingAgentBudget;
  metadata: {
    task_id: string;
    worktree_id: string;
    workflow_id: string;
    step_id: string;
    agent_id: string;
    model_id?: string;
  };
}

export interface CodingAgentUsage {
  input_tokens?: number;
  output_tokens?: number;
  cached_tokens?: number;
  cost_usd?: number;
  model_id?: string;
  provider: string;
}

export interface CodingAgentOutput {
  branch?: string;
  diff_summary?: string;
  pr_ready: boolean;
  logs?: string;
  /** Set when a permission tier blocks the run. The agent can read this directly. */
  observation?: string;
  usage: CodingAgentUsage;
  status: CodingAgentStatus;
  error_class?: string;
}

export interface CodingAgent {
  readonly id: "cursor" | "codex" | string;
  run(input: CodingAgentInput): Promise<CodingAgentOutput>;
}
