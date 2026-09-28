/**
 * Injectible telemetry for Jev MCP mid-run tools (ENG-27).
 * Default wiring to CANONICAL_SPAN.jevDecision lives in src/jev-mcp (keeps gateway free of OTel).
 */

export type JevMcpToolName = "jev_evaluate" | "jev_decide";

export interface JevMcpDecisionEvent {
  tool: JevMcpToolName;
  taskId: string;
  outcome: string;
  reason: string;
  midrunKind: string;
}

export interface JevMcpTelemetry {
  record(event: JevMcpDecisionEvent): Promise<void> | void;
}

export const noopJevMcpTelemetry: JevMcpTelemetry = {
  record() {
    /* intentional no-op for unit tests / fail-open */
  },
};
