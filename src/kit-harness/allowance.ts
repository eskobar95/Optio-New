/**
 * Per-run tool budget. Armed only when the caller sends run_id and max_tool_calls.
 * The call that would exceed the cap is denied and does not consume another slot.
 */
import type { ToolAllowance, ToolContext } from "./types.js";

const usedByRun = new Map<string, number>();

export function clearToolAllowances(): void {
  usedByRun.clear();
}

export function reserveToolAllowance(
  context: ToolContext,
): { exceeded: boolean; allowance: ToolAllowance } | null {
  const runId = context.run_id?.trim();
  const max = context.max_tool_calls;
  if (!runId || max === undefined || !Number.isInteger(max) || max < 1) return null;

  const used = usedByRun.get(runId) ?? 0;
  if (used >= max) {
    return { exceeded: true, allowance: { run_id: runId, used, max } };
  }
  const next = used + 1;
  usedByRun.set(runId, next);
  return { exceeded: false, allowance: { run_id: runId, used: next, max } };
}
