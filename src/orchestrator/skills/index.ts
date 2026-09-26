/**
 * EVE-2 SkillLoader. Other modules import {@link createWorkflowSkillLoader}.
 * The agent-loop excerpt resolver stays `createInstalledSkillLoader` in `src/agent/skills.ts`.
 */
export {
  FROM_PLANNER_SELECTION,
  SkillBudgetDeniedError,
  createWorkflowSkillLoader,
  type ComputeAllowListInput,
  type WorkflowLoadedSkill,
  type WorkflowSkillLoader,
  type WorkflowSkillLoaderOptions,
} from "./loader.js";
