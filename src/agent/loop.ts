/**
 * Minimal request → model adapter → response loop (New Bot slice).
 * Does not own BullMQ, worktrees, or provider credentials.
 */

import type { ModelAdapter, ModelResponse } from "./adapter.js";

export type { ModelAdapter, ModelRequest, ModelResponse } from "./adapter.js";

export interface AgentLoopInput {
  prompt: string;
}

export async function runAgentLoop(
  input: AgentLoopInput,
  adapter: ModelAdapter,
): Promise<ModelResponse> {
  const response = await adapter.complete({ prompt: input.prompt });
  return { text: response.text };
}
