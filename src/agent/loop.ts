/**
 * Request → skill budget → model adapter → gated tool effects → response.
 *
 * Order is fixed: resolve skills, call the adapter, then run hard security gates
 * before any tool effect. A decision sidecar cannot override a deny.
 * See `skills.ts` and AGENTS.md ("Request-response loop") for which installed
 * skills load. Caveman stays opt-in. This module does not own BullMQ, worktrees, or keys.
 */

import { guardToolCall } from "../harness/gates/guard.js";
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
import type { ModelAdapter } from "./adapter.js";
import {
  createInstalledSkillLoader,
  DEFAULT_SKILL_BUDGET,
  type SkillBudget,
  type SkillLoader,
} from "./skills.js";

export type { ModelAdapter, ModelRequest, ModelResponse, ModelToolCall } from "./adapter.js";
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
  tools?: AgentToolRuntime;
  taskId?: string;
  worktreeId?: string;
  stepId?: string;
  tracer?: StageTracer;
}

export interface AgentLoopResult {
  text: string;
  toolResults?: readonly GuardedToolResult[];
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
  if (!input.tools || !toolCalls || toolCalls.length === 0) {
    return { text: response.text };
  }

  const toolResults: GuardedToolResult[] = [];
  for (const call of toolCalls) {
    toolResults.push(
      await guardToolCall({
        request: {
          ...call,
          worktreeRoot: input.tools.worktreeRoot,
          taskId: input.tools.taskId,
          stepId: input.tools.stepId,
        },
        execute: input.tools.execute,
        audit: input.tools.audit,
        sidecar: input.tools.sidecar,
        timeoutMs: input.tools.timeoutMs,
        now: input.tools.now,
        tracer: input.tracer,
      }),
    );
  }

  return { text: response.text, toolResults };
}
