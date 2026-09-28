/**
 * Opt-in skill / MCP pick seam (ENG-25 gate #3).
 * Call before Flue/CodingAgent spawn. Not wired into processStageJob by default.
 *
 * Soft fail-open maps to empty selection + `source: "passthrough"` (no cold reload of full library).
 * Hard timeout (`passthroughOnTimeout: false`) throws `SkillPickTimeoutError`.
 */

import {
  SkillPickTimeoutError,
  runSkillPickGate,
  type SkillPickOutcome,
  type SkillPickPassthroughReason,
} from "../../../gateway/jev-router/gates/skill-pick.js";
import type {
  SkillPickGateConfig,
  SkillPickGateState,
} from "../../../gateway/jev-router/gates/types.js";
import type { JevClient } from "../../../gateway/jev-router/jev-client.js";
import type { SkillPickLogStore } from "./skill-pick-log.js";

export type SkillPickSource = "skill_pick" | "passthrough";

/** Mapped decision for callers before spawn. */
export type SkillPickDecision =
  | {
      source: "skill_pick";
      skillIds: string[];
      mcpToolIds: string[];
      confidence: number;
      notes?: string;
    }
  | {
      source: "passthrough";
      skillIds: [];
      mcpToolIds: [];
      reason: SkillPickPassthroughReason;
      confidence?: number;
      message?: string;
      notes?: string;
    };

/** Structured log entry for the feedback loop (task type + selected skills + outcome). */
export interface SkillPickLogEntry {
  task_id?: string;
  task_type?: string;
  selected_skill_ids: string[];
  selected_mcp_tool_ids?: string[];
  /** Gate/signal outcome: `selected`, soft `passthrough`, or hard `error`. */
  outcome: "selected" | "passthrough" | "error";
  confidence?: number;
  reason?: SkillPickPassthroughReason;
  notes?: string;
  message?: string;
}

export type SkillPickLogFn = (entry: SkillPickLogEntry) => void | Promise<void>;

/**
 * Map a skill-pick outcome onto a spawn-ready decision.
 * Soft passthrough → empty ids (do **not** inject the full allow-list).
 * Hard timeout (`kind: "error"`) throws `SkillPickTimeoutError`.
 */
export function applySkillPick(outcome: SkillPickOutcome): SkillPickDecision {
  if (outcome.kind === "error") {
    throw new SkillPickTimeoutError(outcome.message);
  }
  if (outcome.kind === "decided") {
    return {
      source: "skill_pick",
      skillIds: outcome.skillIds,
      mcpToolIds: outcome.mcpToolIds,
      confidence: outcome.confidence,
      ...(outcome.notes !== undefined ? { notes: outcome.notes } : {}),
    };
  }
  return {
    source: "passthrough",
    skillIds: [],
    mcpToolIds: [],
    reason: outcome.reason,
    ...(outcome.confidence !== undefined ? { confidence: outcome.confidence } : {}),
    ...(outcome.message !== undefined ? { message: outcome.message } : {}),
    ...(outcome.notes !== undefined ? { notes: outcome.notes } : {}),
  };
}

function taskFields(state: SkillPickGateState): Pick<SkillPickLogEntry, "task_id" | "task_type"> {
  return {
    ...(typeof state.task_id === "string" ? { task_id: state.task_id } : {}),
    ...(typeof state.task_type === "string" ? { task_type: state.task_type } : {}),
  };
}

function logEntryFrom(state: SkillPickGateState, decision: SkillPickDecision): SkillPickLogEntry {
  const base = taskFields(state);
  if (decision.source === "passthrough") {
    return {
      ...base,
      selected_skill_ids: [],
      selected_mcp_tool_ids: [],
      outcome: "passthrough",
      reason: decision.reason,
      ...(decision.confidence !== undefined ? { confidence: decision.confidence } : {}),
      ...(decision.notes !== undefined ? { notes: decision.notes } : {}),
      ...(decision.message !== undefined ? { message: decision.message } : {}),
    };
  }
  return {
    ...base,
    selected_skill_ids: decision.skillIds,
    selected_mcp_tool_ids: decision.mcpToolIds,
    outcome: "selected",
    confidence: decision.confidence,
    ...(decision.notes !== undefined ? { notes: decision.notes } : {}),
  };
}

function logHardTimeout(state: SkillPickGateState, message?: string): SkillPickLogEntry {
  return {
    ...taskFields(state),
    selected_skill_ids: [],
    selected_mcp_tool_ids: [],
    outcome: "error",
    reason: "timeout",
    ...(message !== undefined ? { message } : {}),
  };
}

function assertLogStoreConfig(options: {
  logStore?: SkillPickLogStore;
  workspaceId?: string;
}): void {
  if (options.logStore && !options.workspaceId) {
    throw new Error("SkillPickLogStore requires workspaceId");
  }
}

async function emitLog(
  entry: SkillPickLogEntry,
  options: {
    onLog?: SkillPickLogFn;
    logStore?: SkillPickLogStore;
    workspaceId?: string;
    agentId?: string;
  },
): Promise<void> {
  try {
    await options.onLog?.(entry);
    if (options.logStore && options.workspaceId) {
      await options.logStore.append({
        workspaceId: options.workspaceId,
        taskId: entry.task_id,
        taskType: entry.task_type,
        agentId: options.agentId,
        selectedSkillIds: entry.selected_skill_ids,
        outcome: entry.outcome,
      });
    }
  } catch {
    // Logging must not fail the pick decision after a successful gate outcome.
  }
}

/**
 * Opt-in path: run Jev skill pick, map to spawn decision, log once for feedback.
 * Hard timeout still emits `onLog` / `logStore` (`outcome: "error"`) before rethrowing.
 */
export async function evaluateSkillPickWithGate(input: {
  client: JevClient;
  state: SkillPickGateState;
  config?: Partial<SkillPickGateConfig>;
  onLog?: SkillPickLogFn;
  /** Optional persistence into `optio.skill_pick_logs` (requires workspaceId). */
  logStore?: SkillPickLogStore;
  workspaceId?: string;
  agentId?: string;
}): Promise<SkillPickDecision> {
  assertLogStoreConfig(input);

  const outcome = await runSkillPickGate({
    client: input.client,
    state: input.state,
    config: input.config,
  });
  try {
    const decision = applySkillPick(outcome);
    await emitLog(logEntryFrom(input.state, decision), input);
    return decision;
  } catch (error) {
    if (error instanceof SkillPickTimeoutError) {
      await emitLog(logHardTimeout(input.state, error.message), input);
    }
    throw error;
  }
}

export { SkillPickTimeoutError };
