/**
 * Eve-compatible filesystem contract for phase agents and specialist slots.
 *
 * Stubs only. Skill loading stays in `src/agent/skills.ts` (reads `.cursor/`
 * directly). No eve-runner HTTP and no Vercel Workflows/Sandbox client.
 * BullMQ owns graph transitions. These objects do not start sessions.
 */

export const PHASES = ["planner", "implementation", "review", "ready", "merge"] as const;

export type PhaseId = (typeof PHASES)[number];

export type ToolPolicyMode = "none" | "read_only" | "worktree_mutate" | "pr_only" | "merge_only";

/** Concrete model id is chosen by the orchestrator (Jev hop), not by this file. */
export interface ModelPolicyStub {
  selection: "orchestrator";
}

export interface ToolPolicyStub {
  mode: ToolPolicyMode;
  /** Filenames under `tools/`. Empty means the slot is reserved and unused. */
  localTools: readonly string[];
  /** Phase agents and specialists never advance the BullMQ graph. */
  advancesWorkflow: false;
}

export interface SkillsSlot {
  /** Relative to the phase directory. Bodies stay in `.cursor/skills`. */
  index: "skills/index.json";
  sourceOfTruth: ".cursor/skills";
  /**
   * `fixed` — `allowed` is the step budget from `workflows/default-task.yaml`.
   * `from_planner_selection` — planner narrows `allowed` (the candidate pool).
   */
  mode: "fixed" | "from_planner_selection";
  allowed: readonly string[];
}

/** Entry and exit gates copied from the matching step in `workflows/default-task.yaml`. */
export interface PhaseGates {
  entry: readonly string[];
  exit: readonly string[];
  /** Present when the workflow step sets `on_fail`. */
  onFail?: string;
  /** Present when the workflow step sets `on_success`. */
  onSuccess?: string;
}

export interface PhaseAgentDefinition {
  id: `agents/${PhaseId}`;
  phase: PhaseId;
  model: ModelPolicyStub;
  toolPolicy: ToolPolicyStub;
  skills: SkillsSlot;
  specialistsAllowed: readonly string[];
  /**
   * Workflow gates. `toolPolicy.advancesWorkflow` stays false: the orchestrator
   * advances BullMQ after `exit` passes.
   */
  gates: PhaseGates;
}

export interface SpecialistDefinition {
  id: `specialists/${string}`;
  cursorNativeId: string;
  /** Prompt body. Do not copy it into `instructions.md`. */
  cursorNativePath: string;
  model: ModelPolicyStub;
  toolPolicy: ToolPolicyStub;
}

export function definePhaseAgent<T extends PhaseAgentDefinition>(definition: T): T {
  return definition;
}

export function defineSpecialist<T extends SpecialistDefinition>(definition: T): T {
  return definition;
}
