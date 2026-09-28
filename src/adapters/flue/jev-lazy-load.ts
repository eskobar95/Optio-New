/**
 * Injectable Jev skill-pick / lazy-load port (ENG-36 stub).
 * Real Jev client, gates, and HTTP belong to ENG-25 — do not invent jevClient here.
 */

export interface JevSkillPickInput {
  taskId: string;
  stage: string;
  prompt: string;
  /** Full skill registry ids visible to the picker. */
  registry: readonly string[];
}

export interface JevSkillPickResult {
  skillIds: string[];
  reason?: string;
}

/**
 * Soft seam for dynamic skill selection. Optio injects a stub or (later) ENG-25.
 * Timeout / fail-open semantics are owned by ENG-25.
 */
export interface JevSkillPickPort {
  pickSkills(input: JevSkillPickInput): Promise<JevSkillPickResult>;
}

/** Default stub: select nothing (no network). ENG-25 replaces this. */
export function createPassthroughJevSkillPick(): JevSkillPickPort {
  return {
    async pickSkills(_input: JevSkillPickInput): Promise<JevSkillPickResult> {
      return { skillIds: [], reason: "passthrough_stub" };
    },
  };
}

/** Format chosen skill ids for a stub instruction line (no real loading). */
export function formatSkillPickInstructions(result: JevSkillPickResult): string {
  if (result.skillIds.length === 0) return "";
  const reason = result.reason ? ` (${result.reason})` : "";
  return `## Jev skill pick (stub)${reason}\nSkills: ${result.skillIds.join(", ")}`;
}
