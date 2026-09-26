/**
 * Request → skill budget → model adapter → response (New Bot slice).
 *
 * Order is fixed: resolve skills, then call the adapter. See `skills.ts`
 * and AGENTS.md ("Request-response loop") for which installed skills load.
 * Caveman stays opt-in. This module does not own BullMQ, worktrees, or keys.
 */

import type { ModelAdapter, ModelResponse } from "./adapter.js";
import {
  createInstalledSkillLoader,
  DEFAULT_SKILL_BUDGET,
  type SkillBudget,
  type SkillLoader,
} from "./skills.js";

export type { ModelAdapter, ModelRequest, ModelResponse } from "./adapter.js";
export type { LoadedSkill, SkillBudget, SkillLoader, SkillResolveInput } from "./skills.js";
export { createInstalledSkillLoader, DEFAULT_SKILL_BUDGET, cavemanRequested } from "./skills.js";

const defaultSkillLoader = createInstalledSkillLoader();

export interface AgentLoopInput {
  prompt: string;
  /** Opt-in Caveman brevity skill. Default off. `/caveman off` wins. */
  caveman?: boolean;
  skillBudget?: SkillBudget;
}

export async function runAgentLoop(
  input: AgentLoopInput,
  adapter: ModelAdapter,
  skillLoader: SkillLoader = defaultSkillLoader,
): Promise<ModelResponse> {
  const budget = input.skillBudget ?? DEFAULT_SKILL_BUDGET;
  const skills = await skillLoader.resolve(
    { prompt: input.prompt, caveman: input.caveman },
    budget,
  );
  const response = await adapter.complete({ prompt: input.prompt, skills });
  return { text: response.text };
}
