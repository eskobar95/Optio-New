/**
 * Request → skill budget → model adapter → gated tool effects → response.
 *
 * Order is fixed: resolve skills, call the adapter, then run hard security gates
 * before any tool effect. A decision sidecar cannot override a deny.
 * `load_skill` outside `activeSkillBudget` is a hard deny (`skill_budget`).
 * See `skills.ts` and AGENTS.md ("Request-response loop") for which installed
 * skills load. Caveman stays opt-in. This module does not own BullMQ, worktrees, or keys.
 */

import { guardToolCall } from "../harness/gates/guard.js";
import {
  createWorkflowSkillLoader,
  type WorkflowSkillLoader,
} from "../orchestrator/skills/loader.js";
import type {
  AuditSink,
  DecisionSidecar,
  GuardedToolResult,
  ModelToolCall,
} from "../harness/gates/types.js";
import {
  CANONICAL_SPAN,
  getStageTracer,
  type StageTracer,
} from "../orchestrator/telemetry/index.js";
import type { ModelAdapter, ModelUsage } from "./adapter.js";
import {
  createInstalledSkillLoader,
  DEFAULT_SKILL_BUDGET,
  type SkillBudget,
  type SkillLoader,
} from "./skills.js";

export type {
  ModelAdapter,
  ModelRequest,
  ModelResponse,
  ModelToolCall,
  ModelUsage,
} from "./adapter.js";
export type { LoadedSkill, SkillBudget, SkillLoader, SkillResolveInput } from "./skills.js";
export { createInstalledSkillLoader, DEFAULT_SKILL_BUDGET, cavemanRequested } from "./skills.js";
export type {
  AuditEvent,
  AuditSink,
  DecisionSidecar,
  GateDecision,
  GuardedToolResult,
  SidecarAdvice,
} from "../harness/gates/types.js";

const defaultSkillLoader = createInstalledSkillLoader();

export interface AgentToolRuntime {
  execute: (call: ModelToolCall, signal: AbortSignal) => Promise<unknown>;
  audit: AuditSink;
  /** Kit-harness decision sidecar, or the stub from `createStubDecisionSidecar`. */
  sidecar?: DecisionSidecar;
  timeoutMs?: number;
  worktreeRoot?: string;
  taskId?: string;
  stepId?: string;
  now?: () => Date;
}

export interface AgentLoopInput {
  prompt: string;
  /** Opt-in Caveman brevity skill. Default off. `/caveman off` wins. */
  caveman?: boolean;
  skillBudget?: SkillBudget;
  /**
   * Workflow allow-list for the `load_skill` tool. Ids outside this list are
   * hard-denied by the harness gate. Omitted means the tool may load nothing.
   */
  activeSkillBudget?: readonly string[];
  /** Defaults to the control-plane SkillLoader (`createWorkflowSkillLoader`). */
  workflowSkills?: WorkflowSkillLoader;
  tools?: AgentToolRuntime;
  taskId?: string;
  worktreeId?: string;
  stepId?: string;
  tracer?: StageTracer;
}

export interface AgentLoopResult {
  text: string;
  toolResults?: readonly GuardedToolResult[];
  /** Copied from the adapter when it reported usage. */
  usage?: ModelUsage;
}

export async function runAgentLoop(
  input: AgentLoopInput,
  adapter: ModelAdapter,
  skillLoader: SkillLoader = defaultSkillLoader,
): Promise<AgentLoopResult> {
  const budget = input.skillBudget ?? DEFAULT_SKILL_BUDGET;
  const skills = await skillLoader.resolve(
    { prompt: input.prompt, caveman: input.caveman },
    budget,
  );
  if (skills.length > 0) {
    const tracer = input.tracer ?? getStageTracer();
    const taskId = input.taskId ?? input.tools?.taskId ?? "";
    const worktreeId = input.worktreeId ?? "";
    const stepId = input.stepId ?? input.tools?.stepId;
    for (const skill of skills) {
      await tracer.runStage(
        CANONICAL_SPAN.skillLoad,
        {
          taskId,
          worktreeId,
          attributes: {
            skill_id: skill.id,
            ...(stepId ? { step_id: stepId } : {}),
          },
        },
        async () => undefined,
      );
    }
  }
  const response = await adapter.complete({ prompt: input.prompt, skills });
  const toolCalls = response.toolCalls;
  const tools = input.tools;
  if (!tools || !toolCalls || toolCalls.length === 0) {
    return loopResult(response.text, response.usage);
  }

  const toolResults: GuardedToolResult[] = [];
  const activeSkillBudget = input.activeSkillBudget ?? [];
  const workflowSkills = input.workflowSkills ?? createWorkflowSkillLoader();
  for (const call of toolCalls) {
    toolResults.push(
      await guardToolCall({
        request: {
          ...call,
          worktreeRoot: tools.worktreeRoot,
          taskId: tools.taskId,
          stepId: tools.stepId,
          skillBudget: activeSkillBudget,
        },
        execute: async (gated, signal) => {
          if (gated.tool === "load_skill") {
            return workflowSkills.loadSkill(gated.skillId ?? "", activeSkillBudget);
          }
          return tools.execute(gated, signal);
        },
        audit: tools.audit,
        sidecar: tools.sidecar,
        timeoutMs: tools.timeoutMs,
        now: tools.now,
        tracer: input.tracer,
      }),
    );
  }

  return loopResult(response.text, response.usage, toolResults);
}

function loopResult(
  text: string,
  usage: ModelUsage | undefined,
  toolResults?: GuardedToolResult[],
): AgentLoopResult {
  const result: AgentLoopResult = { text };
  if (toolResults) result.toolResults = toolResults;
  if (usage) result.usage = usage;
  return result;
}
