/**
 * Hard security gates (SPEC §9.1).
 * Secrets and harness self-config are denied in deterministic code.
 * A kit-harness decision sidecar may advise soft tool-gates afterwards;
 * it is not consulted on a hard deny and cannot override one.
 */

export type ToolAction = "read" | "write" | "exec";

export type GateId = "secrets" | "config_lock" | "tool_timeout" | "sidecar" | "none";

export type GateVerdict = "allow" | "deny";

/** Tool call proposed by the model. The loop gates this before any effect. */
export interface ModelToolCall {
  tool: string;
  action: ToolAction;
  path?: string;
  command?: string;
}

export interface ToolCallRequest extends ModelToolCall {
  worktreeRoot?: string;
  taskId?: string;
  stepId?: string;
}

export interface GateDecision {
  verdict: GateVerdict;
  gate: GateId;
  reason: string;
  audited: boolean;
}

export interface AuditEvent {
  at: string;
  taskId?: string;
  stepId?: string;
  gate: Exclude<GateId, "none">;
  verdict: "deny";
  action: ToolAction;
  tool: string;
  path?: string;
  reason: string;
}

export interface AuditSink {
  record(event: AuditEvent): void | Promise<void>;
}

export interface SidecarAdvice {
  verdict: "allow" | "deny" | "confirm";
  reason: string;
}

/**
 * Soft tool-gate. Implemented for real by a kit-harness decision sidecar;
 * {@link createStubDecisionSidecar} stands in until that sidecar is injected.
 */
export interface DecisionSidecar {
  advise(request: ToolCallRequest): Promise<SidecarAdvice>;
}

export type GuardedToolResult =
  | { status: "allowed"; value: unknown; decision: GateDecision }
  | { status: "denied"; decision: GateDecision }
  | { status: "cancelled"; decision: GateDecision };

/** Default wall-clock budget for one tool effect inside the agent loop. */
export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
