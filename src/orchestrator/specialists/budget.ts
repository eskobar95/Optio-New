/**
 * Narrow a parent implementation step down to one specialist.
 * Review, merge, and workflow-advance capabilities never survive the cut.
 */

export const IMPLEMENTATION_STEP_ID = "implementation";
export const IMPLEMENTATION_AGENT_ID = "agents/implementation";

/** Tools the implementation step may hold. Specialists receive a subset. */
export const IMPLEMENTATION_PARENT_TOOLS = [
  "read_file",
  "grep",
  "glob",
  "edit_file",
  "write_file",
  "list_dir",
  "bash",
  "shell",
  "run_tests",
  "typecheck",
  "lint",
  "load_skill",
  "invoke_specialist",
] as const;

/** Calling any of these would move a BullMQ stage. Specialists cannot. */
export const STEP_ADVANCE_TOOLS = [
  "advance_step",
  "complete_step",
  "enqueue_job",
  "move_job",
  "workflow.advance",
  "bullmq.advance",
] as const;

const STEP_ADVANCE = new Set<string>(STEP_ADVANCE_TOOLS);

/** Skills that belong to other phases or to the orchestrator. */
const PHASE_DENIED_SKILLS = new Set([
  "skills/code-review",
  "skills/land",
  "skills/reap-worktree",
  "skills/sync-development",
  "skills/bot-session",
  "skills/handoff",
  "skills/signal-up",
]);

export function isStepAdvanceTool(tool: string): boolean {
  return STEP_ADVANCE.has(tool);
}

export function specialistToolBudget(
  folderTools: readonly string[],
  parentTools: readonly string[] = IMPLEMENTATION_PARENT_TOOLS,
): string[] {
  const parent = new Set(parentTools);
  const seen = new Set<string>();
  const tools: string[] = [];
  for (const tool of folderTools) {
    if (isStepAdvanceTool(tool)) continue;
    if (tool === "invoke_specialist") continue;
    if (!parent.has(tool)) continue;
    if (seen.has(tool)) continue;
    seen.add(tool);
    tools.push(tool);
  }
  return tools;
}

export function specialistSkillBudget(
  folderSkills: readonly string[],
  parentSkills: readonly string[],
): string[] {
  const parent = new Set(parentSkills);
  const seen = new Set<string>();
  const skills: string[] = [];
  for (const skill of folderSkills) {
    if (!parent.has(skill)) continue;
    if (PHASE_DENIED_SKILLS.has(skill)) continue;
    if (seen.has(skill)) continue;
    seen.add(skill);
    skills.push(skill);
  }
  return skills;
}
