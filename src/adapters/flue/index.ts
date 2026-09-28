/**
 * Flue CodingAgent backend (ENG-26).
 * Calls the Flue sidecar over HTTP; Cursor CLI is a tool Flue owns, not this adapter.
 * Re-dispatches on network / 5xx (see createFlueClient).
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
import type { FlueUsageEvent } from "./contract.js";

export interface FlueAdapterDeps extends CodingAgentDeps {
  flue?: FlueClientOptions & { client?: FlueClient };
}

function usageFromEvents(events: FlueUsageEvent[], modelId?: string): CodingAgentUsage {
  let input_tokens = 0;
  let output_tokens = 0;
  let cached_tokens = 0;
  let cost_usd = 0;
  let provider = "flue";
  let lastModel = modelId;

  for (const event of events) {
    if (event.inputTokens != null) input_tokens += event.inputTokens;
    if (event.outputTokens != null) output_tokens += event.outputTokens;
    if (event.cachedTokens != null) cached_tokens += event.cachedTokens;
    if (event.costUsd != null) cost_usd += event.costUsd;
    if (event.provider) provider = event.provider;
    if (event.modelId) lastModel = event.modelId;
  }

  const usage: CodingAgentUsage = { provider };
  if (input_tokens > 0) usage.input_tokens = input_tokens;
  if (output_tokens > 0) usage.output_tokens = output_tokens;
  if (cached_tokens > 0) usage.cached_tokens = cached_tokens;
  if (cost_usd > 0) usage.cost_usd = cost_usd;
  if (lastModel) usage.model_id = lastModel;
  return usage;
}

function toDispatchBody(input: CodingAgentInput) {
  return {
    taskId: input.metadata.task_id,
    worktreeId: input.metadata.worktree_id,
    workflowId: input.metadata.workflow_id,
    stepId: input.metadata.step_id,
    agentId: input.metadata.agent_id,
    workspaceRef: input.worktree_path,
    sandboxMode: "local" as const,
    prompt: input.prompt,
    instructions: input.instructions,
    allowedTools: input.allowed_tools,
    modelId: input.metadata.model_id,
  };
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
    });

  return {
    id: "flue",
    async run(input: CodingAgentInput): Promise<CodingAgentOutput> {
      try {
        const { start } = await client.dispatchAndStart(toDispatchBody(input), {
          taskId: input.metadata.task_id,
        });
        const usage = usageFromEvents(start.usageEvents, input.metadata.model_id);
        if (start.status === "failed") {
          return {
            branch: start.branch,
            pr_ready: Boolean(start.prUrl),
            logs: start.logs,
            usage,
            status: "failed",
            error_class: start.errorClass ?? "flue_run_failed",
          };
        }
        return {
          branch: start.branch,
          pr_ready: Boolean(start.prUrl),
          logs: start.logs,
          usage,
          status: "succeeded",
          ...(start.prUrl ? { diff_summary: `pr: ${start.prUrl}` } : {}),
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
