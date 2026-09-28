/**
 * Default Jev MCP telemetry → CANONICAL_SPAN.jevDecision (ENG-27).
 * Keeps gateway free of OTel; CLI and callers inject this sink.
 */

import type { JevMcpDecisionEvent, JevMcpTelemetry } from "../../gateway/jev-router/mcp/index.js";
import { CANONICAL_SPAN } from "../orchestrator/telemetry/spans.js";
import { getStageTracer, type StageTracer } from "../orchestrator/telemetry/tracer.js";

export function createOtelJevMcpTelemetry(tracer: StageTracer = getStageTracer()): JevMcpTelemetry {
  return {
    async record(event: JevMcpDecisionEvent) {
      await tracer.runStage(
        CANONICAL_SPAN.jevDecision,
        {
          taskId: event.taskId,
          worktreeId: "",
          attributes: {
            tool: event.tool,
            outcome: event.outcome,
            reason: event.reason,
            midrun_kind: event.midrunKind,
          },
        },
        () => undefined,
      );
    },
  };
}
