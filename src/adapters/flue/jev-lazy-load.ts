/**
 * Flue-side Jev skill-pick port types (ENG-36 seam + ENG-25 gate #3).
 * Port implementation lives in orchestrator (`createJevSkillPickPort`) — adapters stay thin.
 */

export interface JevSkillPickInput {
  taskId: string;
  stage: string;
  prompt: string;
  /** Full skill registry ids visible to the picker (allow-list max). */
  registry: readonly string[];
  /** Optional MCP capability / tool allow-list max. */
  mcpRegistry?: readonly string[];
  taskType?: string;
  workflowId?: string;
  stepId?: string;
}

export interface JevSkillPickResult {
  skillIds: string[];
  mcpToolIds?: string[];
  reason?: string;
  confidence?: number;
}

/**
 * Soft seam for dynamic skill selection.
 * Soft timeout → empty selection; Flue fail-opens on non-timeout errors.
 * Hard `SkillPickTimeoutError` is rethrown by the Flue adapter.
 */
export interface JevSkillPickPort {
  pickSkills(input: JevSkillPickInput): Promise<JevSkillPickResult>;
}

/** Default stub: select nothing (no network). */
export function createPassthroughJevSkillPick(): JevSkillPickPort {
  return {
    async pickSkills(_input: JevSkillPickInput): Promise<JevSkillPickResult> {
      return { skillIds: [], mcpToolIds: [], reason: "passthrough_stub" };
    },
  };
}

/** Format chosen skill / MCP ids for Flue dispatch instructions (lazy — not full bodies). */
export function formatSkillPickInstructions(result: JevSkillPickResult): string {
  const skills = result.skillIds;
  const mcp = result.mcpToolIds ?? [];
  if (skills.length === 0 && mcp.length === 0) return "";
  const reason = result.reason ? ` (${result.reason})` : "";
  const lines = [`## Jev skill pick${reason}`];
  if (skills.length > 0) lines.push(`Skills: ${skills.join(", ")}`);
  if (mcp.length > 0) lines.push(`MCP tools: ${mcp.join(", ")}`);
  return lines.join("\n");
}

/**
 * When Jev returns MCP tool ids that overlap `allowedTools`, narrow the tool allow-list.
 * No overlap → leave `allowedTools` unchanged (instructions still carry the advisory pick).
 */
export function narrowAllowedTools(
  allowedTools: readonly string[],
  mcpToolIds: readonly string[] | undefined,
): string[] {
  if (!mcpToolIds || mcpToolIds.length === 0) return [...allowedTools];
  const picked = new Set(mcpToolIds);
  const narrowed = allowedTools.filter((id) => picked.has(id));
  return narrowed.length > 0 ? narrowed : [...allowedTools];
}
