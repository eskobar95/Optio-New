/**
 * Stage hook for skill seed/reap around worktree create and delete.
 * Git worktree registration stays in `WorktreeManager`.
 */
import { EveSkillLoader, type SkillAllowListInput } from "./skill-loader.js";

export class EveWorktreeSkillSeed {
  constructor(private readonly skills: EveSkillLoader) {}

  async onCreate(
    input: SkillAllowListInput & { worktreePath: string },
  ): Promise<{ allowList: string[] }> {
    const allowList = this.skills.resolveAllowList(input);
    await this.skills.materialize(input.worktreePath, allowList);
    return { allowList };
  }

  async onDelete(worktreePath: string): Promise<void> {
    await this.skills.reapMaterialized(worktreePath);
  }
}
