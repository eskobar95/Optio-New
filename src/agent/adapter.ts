/**
 * Swappable model boundary for the request-response agent loop.
 * Callers inject an implementation; the loop does not open a network connection.
 */

import type { LoadedSkill } from "./skills.js";

export interface ModelRequest {
  prompt: string;
  /** Excerpts resolved from `.cursor/skills` and `.cursor/agents` before this call. */
  skills?: LoadedSkill[];
}

export interface ModelResponse {
  text: string;
}

export interface ModelAdapter {
  complete(request: ModelRequest): Promise<ModelResponse>;
}
