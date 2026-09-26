/**
 * Eve-runner skill access. This is the EVE-2 loader (`createWorkflowSkillLoader`):
 * allow-list from the workflow step, hard deny outside that budget, seed/reap under
 * the worktree `.agents/skills`. There is no separate stub.
 */
export {
  SkillBudgetDeniedError,
  createWorkflowSkillLoader,
  type WorkflowLoadedSkill,
  type WorkflowSkillLoader,
} from "../orchestrator/skills/loader.js";
