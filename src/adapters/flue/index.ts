/**
 * Flue CodingAgent backend (ENG-26 + ENG-36 session binding).
 * Calls the Flue sidecar over HTTP; Cursor CLI is a tool Flue owns, not this adapter.
 * Re-dispatches on network / 5xx (see createFlueClient).
 * Pause/approval/retry resume the same durable Flue conversation via SessionBindingStore.
 */

import type {
  CodingAgent,
  CodingAgentInput,
  CodingAgentOutput,
  CodingAgentUsage,
} from "../coding-agent.js";
import type { CodingAgentDeps } from "../runtime.js";
import {
  createFlueClient,
  resolveFlueBaseUrl,
  FlueHttpError,
  type FlueClient,
  type FlueClientOptions,
} from "./client.js";
import type { FlueDispatchRequest, FlueUsageEvent } from "./contract.js";
import {
  createPassthroughJevSkillPick,
  formatSkillPickInstructions,
  type JevSkillPickPort,
  type JevSkillPickResult,
} from "./jev-lazy-load.js";
import { clearReviewFeedback, formatAccumulatedFeedback } from "./review-feedback.js";
import {
  FLUE_IMPLEMENT_BINDING_STAGE,
  getDefaultFlueSessionBindingStore,
  type FlueSessionBindingStore,
} from "./session-binding.js";

export interface FlueAdapterDeps extends CodingAgentDeps {
  flue?: FlueClientOptions & {
    client?: FlueClient;
    /**
     * Optio-side task → Flue session map.
     * Defaults to a process-scoped in-memory store (shared across adapter recreates).
     * Inject a durable store for multi-process workers.
     */
    sessionBinding?: FlueSessionBindingStore;
    /**
     * Injectable Jev skill-pick port.
     * Default: passthrough stub. Prefer `createJevSkillPickPort` (ENG-25 gate #3).
     */
    skillPick?: JevSkillPickPort;
    /** Full skill registry (allow-list max) passed to the skill-pick port. */
    skillRegistry?: readonly string[];
    /** Full MCP capability/tool registry (allow-list max) passed to the skill-pick port. */
    mcpRegistry?: readonly string[];
  };
}

function usageFromEvents(events: FlueUsageEvent[], modelId?: string): CodingAgentUsage {
  let input_tokens = 0;
  let output_tokens = 0;
  let cached_tokens = 0;
  let cost_usd = 0;
  let sawInput = false;
  let sawOutput = false;
  let sawCached = false;
  let sawCost = false;
  let provider = "flue";
  let lastModel = modelId;

  for (const event of events) {
    if (event.inputTokens != null) {
      sawInput = true;
      input_tokens += event.inputTokens;
    }
    if (event.outputTokens != null) {
      sawOutput = true;
      output_tokens += event.outputTokens;
    }
    if (event.cachedTokens != null) {
      sawCached = true;
      cached_tokens += event.cachedTokens;
    }
    if (event.costUsd != null) {
      sawCost = true;
      cost_usd += event.costUsd;
    }
    if (event.provider) provider = event.provider;
    if (event.modelId) lastModel = event.modelId;
  }

  const usage: CodingAgentUsage = { provider };
  if (sawInput) usage.input_tokens = input_tokens;
  if (sawOutput) usage.output_tokens = output_tokens;
  if (sawCached) usage.cached_tokens = cached_tokens;
  if (sawCost) usage.cost_usd = cost_usd;
  if (lastModel) usage.model_id = lastModel;
  return usage;
}

function mergeInstructionParts(...parts: Array<string | undefined>): string | undefined {
  const merged = parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part && part.length > 0));
  return merged.length > 0 ? merged.join("\n\n") : undefined;
}

/** Soft fail-open: skill-pick errors must not block implement (ENG-25 soft-gate). */
async function pickSkillsFailOpen(
  skillPick: JevSkillPickPort,
  input: {
    taskId: string;
    stage: string;
    prompt: string;
    registry: readonly string[];
    mcpRegistry?: readonly string[];
    workflowId?: string;
    stepId?: string;
  },
): Promise<JevSkillPickResult> {
  try {
    return await skillPick.pickSkills(input);
  } catch {
    return { skillIds: [], mcpToolIds: [], reason: "skill_pick_fail_open" };
  }
}

async function toDispatchBody(
  input: CodingAgentInput,
  options: {
    sessionBinding: FlueSessionBindingStore;
    skillPick: JevSkillPickPort;
    skillRegistry: readonly string[];
    mcpRegistry: readonly string[];
  },
): Promise<FlueDispatchRequest> {
  const binding = options.sessionBinding.get(input.metadata.task_id, FLUE_IMPLEMENT_BINDING_STAGE);
  const resumeId = binding?.durableConversationId?.trim();
  const feedbackBlock = formatAccumulatedFeedback(binding?.feedback ?? []);

  const pick = await pickSkillsFailOpen(options.skillPick, {
    taskId: input.metadata.task_id,
    stage: FLUE_IMPLEMENT_BINDING_STAGE,
    prompt: input.prompt,
    registry: options.skillRegistry,
    mcpRegistry: options.mcpRegistry,
    workflowId: input.metadata.workflow_id,
    stepId: input.metadata.step_id,
  });
  const skillBlock = formatSkillPickInstructions(pick);

  return {
    taskId: input.metadata.task_id,
    worktreeId: input.metadata.worktree_id,
    workflowId: input.metadata.workflow_id,
    stepId: input.metadata.step_id,
    agentId: input.metadata.agent_id,
    workspaceRef: input.worktree_path,
    sandboxMode: "local" as const,
    prompt: input.prompt,
    instructions: mergeInstructionParts(input.instructions, feedbackBlock, skillBlock),
    allowedTools: input.allowed_tools,
    modelId: input.metadata.model_id,
    ...(resumeId ? { durableConversationId: resumeId } : {}),
  };
}

function mergeLogs(logs: string | undefined, prUrl: string | undefined): string | undefined {
  const parts = [logs?.trim(), prUrl ? `prUrl=${prUrl}` : undefined].filter(
    (part): part is string => Boolean(part && part.length > 0),
  );
  return parts.length > 0 ? parts.join("\n") : undefined;
}

export function createFlueAdapter(deps: FlueAdapterDeps = {}): CodingAgent {
  const env = deps.env ?? process.env;
  const flueOpts = deps.flue ?? {};
  const client =
    flueOpts.client ??
    createFlueClient({
      baseUrl: flueOpts.baseUrl ?? resolveFlueBaseUrl(env),
      fetchImpl: flueOpts.fetchImpl,
      maxAttempts: flueOpts.maxAttempts,
      timeoutMs: flueOpts.timeoutMs,
    });
  const sessionBinding = flueOpts.sessionBinding ?? getDefaultFlueSessionBindingStore();
  const skillPick = flueOpts.skillPick ?? createPassthroughJevSkillPick();
  const skillRegistry = flueOpts.skillRegistry ?? [];
  const mcpRegistry = flueOpts.mcpRegistry ?? [];

  return {
    id: "flue",
    async run(input: CodingAgentInput): Promise<CodingAgentOutput> {
      try {
        const dispatchBody = await toDispatchBody(input, {
          sessionBinding,
          skillPick,
          skillRegistry,
          mcpRegistry,
        });
        const { start } = await client.dispatchAndStart(dispatchBody, {
          taskId: input.metadata.task_id,
          onDispatched: (bound) => {
            // Persist as soon as Flue accepts/resumes — even if start later fails.
            sessionBinding.put({
              taskId: input.metadata.task_id,
              stage: FLUE_IMPLEMENT_BINDING_STAGE,
              flueSessionId: bound.sessionId,
              durableConversationId: bound.durableConversationId,
            });
          },
        });

        if (start.status === "succeeded") {
          clearReviewFeedback(sessionBinding, input.metadata.task_id);
        }

        const usage = usageFromEvents(start.usageEvents, input.metadata.model_id);
        const logs = mergeLogs(start.logs, start.prUrl);
        const succeeded = start.status === "succeeded";
        return {
          branch: start.branch,
          pr_ready: succeeded && Boolean(start.prUrl),
          logs,
          usage,
          status: succeeded ? "succeeded" : "failed",
          ...(succeeded ? {} : { error_class: start.errorClass ?? "flue_run_failed" }),
        };
      } catch (error) {
        const flueError = error instanceof FlueHttpError ? error : undefined;
        return {
          pr_ready: false,
          logs: error instanceof Error ? error.message : String(error),
          usage: { provider: "flue", model_id: input.metadata.model_id },
          status: "failed",
          error_class: flueError?.errorClass ?? "flue_adapter_error",
        };
      }
    },
  };
}

/** Default Flue adapter using process env for FLUE_BASE_URL. */
export const flueAdapter: CodingAgent = createFlueAdapter();
