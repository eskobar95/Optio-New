/**
 * Process-local audit of denied tool calls.
 * Stdout gets one JSON line per deny. GET /v1/audit returns the same entries.
 */
import { redactSecrets } from "./redact.js";
import type { ToolVerdict } from "./types.js";

const MAX_ENTRIES = 100;
const MAX_COMMAND_CHARS = 400;

export interface ToolAuditEntry {
  ts: string;
  tool: string;
  decision: ToolVerdict;
  reason: string;
  hard: boolean;
  command?: string;
  agent_id?: string;
}

const entries: ToolAuditEntry[] = [];

export function readToolAudit(): ToolAuditEntry[] {
  return entries.map((entry) => ({ ...entry }));
}

export function clearToolAudit(): void {
  entries.length = 0;
}

function clip(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > MAX_COMMAND_CHARS ? `${trimmed.slice(0, MAX_COMMAND_CHARS)}…` : trimmed;
}

/** Record a denied tool attempt and write one structured stdout line. */
export function recordDeniedTool(input: Omit<ToolAuditEntry, "ts" | "decision">): ToolAuditEntry {
  const entry: ToolAuditEntry = {
    ts: new Date().toISOString(),
    tool: input.tool,
    decision: "deny",
    reason: redactSecrets(input.reason),
    hard: input.hard,
    command: clip(input.command ? redactSecrets(input.command) : undefined),
    agent_id: clip(input.agent_id ? redactSecrets(input.agent_id) : undefined),
  };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.shift();
  console.log(
    JSON.stringify({
      service: "kit-harness",
      event: "tool_denied",
      ts: entry.ts,
      tool: entry.tool,
      decision: entry.decision,
      reason: entry.reason,
      hard: entry.hard,
      command: entry.command,
      agent_id: entry.agent_id,
    }),
  );
  return entry;
}
