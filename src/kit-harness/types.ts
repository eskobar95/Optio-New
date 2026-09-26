/**
 * kit-harness decision types (SPEC §9, §14.4 Hop 1).
 * New Bot stays intake. These calls do not enqueue BullMQ work.
 */
import type { PermissionTier } from "./permissions.js";

export type { PermissionTier };

export type DecisionEngine = "rules" | "jev";

export type Hop1Choice = "cursor_subscription" | "codex_gateway" | "deny";

export type ToolVerdict = "allow" | "confirm" | "deny";

export type CompletionVerdict = "pass" | "fail" | "retry";

/** Minimum advisor confidence before a soft Jev choice replaces a rules choice. */
export const ADVISOR_CONFIDENCE_MIN = 0.8;

export interface AdvisorResult {
  choice?: string;
  confidence?: number;
  reason?: string;
}

/**
 * Soft advisor seam. The HTTP server does not call the network in v0.
 * Tests inject a mock. Hard denies never consult this.
 */
export interface DecisionAdvisor {
  advise(input: {
    kind: "route_model" | "tool_gate" | "completion";
    payload: unknown;
  }): Promise<AdvisorResult | null>;
}

export interface RouteModelInput {
  step_id?: string;
  workflow_id?: string;
  task_id?: string;
  coding_backend?: "cursor" | "codex" | "auto";
  cursor_quota_remaining?: number;
  codex_quota_remaining?: number;
  budget_usd_remaining?: number;
  cost_estimate_usd?: number;
  force_deny?: boolean;
}

export interface RouteModelDecision {
  choice: Hop1Choice;
  reason: string;
  engine: DecisionEngine;
  confidence: number;
}

export interface ModelRouter {
  route(input: RouteModelInput): Promise<RouteModelDecision>;
}

export interface ToolContext {
  step_id?: string;
  agent_id?: string;
  /** Groups calls that share one per-run tool budget. */
  run_id?: string;
  /** Cap for `run_id`. Unset means no allowance gate. */
  max_tool_calls?: number;
  command?: string;
  path?: string;
  args?: Record<string, unknown>;
  allowed_tools?: string[];
  /**
   * Explicit ceiling. Omitted uses the stage default for `step_id`,
   * or `read-only` when the step is unknown.
   */
  permission_tier?: PermissionTier;
}

export interface ToolAllowance {
  run_id: string;
  used: number;
  max: number;
}

export interface ToolGateDecision {
  decision: ToolVerdict;
  hard: boolean;
  reason: string;
  engine: DecisionEngine;
  allowance?: ToolAllowance;
  /** Present on a permission deny. The agent reads this instead of a bare reason code. */
  observation?: string;
}

export interface CompletionEvidence {
  tests_green?: boolean;
  typecheck_green?: boolean;
  lint_green?: boolean;
  diff_present?: boolean;
  open_blockers?: string[];
  ci_status?: "success" | "failure" | "pending" | "missing";
  attempt?: number;
  max_attempts?: number;
}

export interface CompletionDecision {
  verdict: CompletionVerdict;
  hard: boolean;
  reason: string;
  engine: DecisionEngine;
}

export interface LoopEvent {
  fingerprint: string;
  tool?: string;
  outcome: "fail" | "ok" | "deny";
}

export interface LoopDetectInput {
  events: LoopEvent[];
  threshold?: number;
  tool_thrash_threshold?: number;
}

export interface LoopDetectResult {
  loop_detected: boolean;
  /** True when the harness says stop. Replan is not a halt. */
  halt: boolean;
  kind?: "repeated_failure" | "tool_thrash";
  suggestion?: "stop" | "replan";
  fingerprint?: string;
  tool?: string;
  count?: number;
  reason: string;
}

export interface SuggestedSubtask {
  title: string;
  rationale: string;
}

export interface SplitInput {
  title?: string;
  description?: string;
  estimated_files?: number;
  estimated_steps?: number;
  signals?: string[];
  max_files_before_split?: number;
  max_steps_before_split?: number;
}

export interface SplitDecision {
  action: "proceed" | "split";
  reason: string;
  subtasks?: SuggestedSubtask[];
}

export function normalizeToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}
