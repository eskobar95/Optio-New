/**
 * Swappable model boundary for the request-response agent loop.
 * Callers inject an implementation; the loop does not open a network connection.
 */

import type { ModelToolCall } from "../harness/gates/types.js";
import type { LoadedSkill } from "./skills.js";

export type { ModelToolCall } from "../harness/gates/types.js";

export interface ModelRequest {
  prompt: string;
  /** Excerpts resolved from `.cursor/skills` and `.cursor/agents` before this call. */
  skills?: LoadedSkill[];
}

/** Token or cost figures a model adapter chose to report. Absent fields are not estimated. */
export interface ModelUsage {
  input_tokens?: number;
  output_tokens?: number;
  cached_tokens?: number;
  cost_usd?: number;
  model_id?: string;
  provider?: string;
}

export interface ModelResponse {
  text: string;
  /** Proposed effects. The loop runs hard gates before executing any of them. */
  toolCalls?: readonly ModelToolCall[];
  /** Present only when the adapter exposes usage. The loop does not invent tokens. */
  usage?: ModelUsage;
  /** Planner confidence in [0, 1]. The HITL gate ignores values outside that range. */
  confidence?: number;
}

export interface ModelAdapter {
  complete(request: ModelRequest): Promise<ModelResponse>;
}
