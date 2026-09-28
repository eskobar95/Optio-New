/**
 * Gate #3 — dynamic skill / MCP pick (ENG-25).
 * Soft gate: timeout / low confidence → passthrough (fail-open) when configured.
 * Allow-list (registry) is max permission; Jev returns a per-task subset.
 */

import type { JevClient, JevClientResult } from "../jev-client.js";
import {
  SkillPickGateAnswerSchema,
  SkillPickGateConfigSchema,
  SkillPickGateStateSchema,
  type SkillPickGateAnswer,
  type SkillPickGateConfig,
  type SkillPickGateState,
} from "./types.js";

export const SKILL_PICK_QUESTION = {
  type: "choice",
  instructions:
    "Dynamic skill / MCP pick. Observe the full skill_registry and mcp_registry (allow-list max). Select only the subset needed for this task. Do not return the entire allow-list. Prefer empty arrays over speculative loads.",
  criteria: {
    skill_ids: "Subset of skill_registry ids relevant to the prompt/task.",
    mcp_tool_ids: "Subset of mcp_registry capability/tool ids needed for the task (optional).",
    confidence: "0–1 confidence in the selection.",
  },
} as const;

export type SkillPickPassthroughReason =
  "timeout" | "http" | "network" | "invalid_url" | "invalid_body" | "low_confidence" | "undecided";

export type SkillPickOutcome =
  | {
      kind: "decided";
      skillIds: string[];
      mcpToolIds: string[];
      confidence: number;
      notes?: string;
    }
  | {
      kind: "passthrough";
      reason: SkillPickPassthroughReason;
      confidence?: number;
      status?: number;
      message?: string;
      notes?: string;
    }
  | {
      /** Hard fail when `passthroughOnTimeout` is false. */
      kind: "error";
      reason: "timeout";
      message?: string;
    };

export class SkillPickTimeoutError extends Error {
  readonly error_class = "skill_pick_timeout";

  constructor(message = "Jev skill pick gate timed out") {
    super(message);
    this.name = "SkillPickTimeoutError";
  }
}

function parseAnswer(payload: unknown): SkillPickGateAnswer | null {
  if (!payload || typeof payload !== "object") return null;
  const answers = (payload as { answers?: unknown }).answers;
  if (!answers || typeof answers !== "object") return null;
  const raw = (answers as { skill_pick?: unknown }).skill_pick;
  const parsed = SkillPickGateAnswerSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function outcomeFromClientError(
  result: Extract<JevClientResult, { ok: false }>,
): Extract<SkillPickOutcome, { kind: "passthrough" }> {
  return {
    kind: "passthrough",
    reason: result.reason,
    ...(result.status !== undefined ? { status: result.status } : {}),
    ...(result.message !== undefined ? { message: result.message } : {}),
  };
}

/** Intersect selected ids with the allow-list registry; drop unknowns; preserve order. */
export function filterToRegistry(
  selected: readonly string[],
  registry: readonly string[],
): string[] {
  const allowed = new Set(registry);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of selected) {
    if (!allowed.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Run gate #3 via shared jevClient.
 * Soft: transport errors / low confidence / undecided → passthrough.
 * Timeout → passthrough when `passthroughOnTimeout` (default), else `kind: "error"`.
 * Decided skill/mcp ids are filtered to the registries in state (allow-list max).
 */
export async function runSkillPickGate(input: {
  client: JevClient;
  state: SkillPickGateState;
  config?: Partial<SkillPickGateConfig>;
}): Promise<SkillPickOutcome> {
  const state = SkillPickGateStateSchema.parse(input.state);
  const config = SkillPickGateConfigSchema.parse(input.config ?? {});

  const result = await input.client.postSystemOne({
    state,
    questions: { skill_pick: SKILL_PICK_QUESTION },
    timeoutMs: config.timeoutMs,
  });

  if (!result.ok) {
    if (result.reason === "timeout" && !config.passthroughOnTimeout) {
      return {
        kind: "error",
        reason: "timeout",
        message: result.message ?? "Jev skill pick gate timed out",
      };
    }
    return outcomeFromClientError(result);
  }

  const answer = parseAnswer(result.payload);
  if (!answer) {
    return { kind: "passthrough", reason: "undecided" };
  }

  if (answer.confidence < config.minConfidence) {
    return {
      kind: "passthrough",
      reason: "low_confidence",
      confidence: answer.confidence,
      ...(answer.notes !== undefined ? { notes: answer.notes } : {}),
    };
  }

  const skillIds = filterToRegistry(answer.skill_ids, state.skill_registry ?? []);
  const mcpToolIds = filterToRegistry(answer.mcp_tool_ids ?? [], state.mcp_registry ?? []);

  return {
    kind: "decided",
    skillIds,
    mcpToolIds,
    confidence: answer.confidence,
    ...(answer.notes !== undefined ? { notes: answer.notes } : {}),
  };
}
