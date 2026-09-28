/**
 * Injectable Jev skill-pick / lazy-load port (ENG-36 seam + ENG-25 gate #3).
 * Default remains passthrough (no network). `createJevSkillPickPort` runs real pick.
 */

import {
  applySkillPick,
  evaluateSkillPickWithGate,
  type SkillPickLogFn,
} from "../../orchestrator/jev/skill-pick-gate.js";
import type { SkillPickLogStore } from "../../orchestrator/jev/skill-pick-log.js";
import type { SkillPickGateConfig } from "../../../gateway/jev-router/gates/types.js";
import type { JevClient } from "../../../gateway/jev-router/jev-client.js";
import { SkillPickTimeoutError } from "../../../gateway/jev-router/gates/skill-pick.js";

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
 * Timeout / fail-open semantics: soft → empty selection; Flue also fail-opens on throw.
 */
export interface JevSkillPickPort {
  pickSkills(input: JevSkillPickInput): Promise<JevSkillPickResult>;
}

export interface CreateJevSkillPickPortOptions {
  client: JevClient;
  config?: Partial<SkillPickGateConfig>;
  onLog?: SkillPickLogFn;
  logStore?: SkillPickLogStore;
  workspaceId?: string;
  agentId?: string;
  /** Default task_type when input omits it. */
  defaultTaskType?: string;
}

/** Default stub: select nothing (no network). */
export function createPassthroughJevSkillPick(): JevSkillPickPort {
  return {
    async pickSkills(_input: JevSkillPickInput): Promise<JevSkillPickResult> {
      return { skillIds: [], mcpToolIds: [], reason: "passthrough_stub" };
    },
  };
}

/**
 * Real gate #3 port: full registry in → Jev subset out (fail-open on soft timeout).
 * Soft passthrough returns empty ids (no cold reload of the whole library).
 * Hard timeout (`passthroughOnTimeout: false`) throws `SkillPickTimeoutError`
 * (Flue adapter still fail-opens via catch).
 */
export function createJevSkillPickPort(options: CreateJevSkillPickPortOptions): JevSkillPickPort {
  return {
    async pickSkills(input: JevSkillPickInput): Promise<JevSkillPickResult> {
      const decision = await evaluateSkillPickWithGate({
        client: options.client,
        state: {
          task_id: input.taskId,
          stage: input.stage,
          prompt: input.prompt,
          skill_registry: [...input.registry],
          mcp_registry: [...(input.mcpRegistry ?? [])],
          ...(input.taskType !== undefined
            ? { task_type: input.taskType }
            : options.defaultTaskType !== undefined
              ? { task_type: options.defaultTaskType }
              : {}),
          ...(input.workflowId !== undefined ? { workflow_id: input.workflowId } : {}),
          ...(input.stepId !== undefined ? { step_id: input.stepId } : {}),
        },
        config: options.config,
        onLog: options.onLog,
        logStore: options.logStore,
        workspaceId: options.workspaceId,
        agentId: options.agentId,
      });

      if (decision.source === "passthrough") {
        return {
          skillIds: [],
          mcpToolIds: [],
          reason: decision.reason,
          ...(decision.confidence !== undefined ? { confidence: decision.confidence } : {}),
        };
      }

      return {
        skillIds: decision.skillIds,
        mcpToolIds: decision.mcpToolIds,
        reason: "skill_pick",
        confidence: decision.confidence,
      };
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

export { SkillPickTimeoutError, applySkillPick };
