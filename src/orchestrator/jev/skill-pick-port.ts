/**
 * Real JevSkillPickPort (ENG-25 gate #3).
 * Lives in orchestrator so Flue adapters stay free of jevClient / gate imports.
 */

import type {
  JevSkillPickInput,
  JevSkillPickPort,
  JevSkillPickResult,
} from "../../adapters/flue/jev-lazy-load.js";
import type { SkillPickGateConfig } from "../../../gateway/jev-router/gates/types.js";
import type { JevClient } from "../../../gateway/jev-router/jev-client.js";
import { evaluateSkillPickWithGate, type SkillPickLogFn } from "./skill-pick-gate.js";
import type { SkillPickLogStore } from "./skill-pick-log.js";

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

/**
 * Full registry in → Jev subset out (fail-open on soft timeout).
 * Soft passthrough returns empty ids (no cold reload of the whole library).
 * Hard timeout (`passthroughOnTimeout: false`) throws `SkillPickTimeoutError`.
 */
export function createJevSkillPickPort(options: CreateJevSkillPickPortOptions): JevSkillPickPort {
  if (options.logStore && !options.workspaceId) {
    throw new Error("createJevSkillPickPort: logStore requires workspaceId");
  }

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
