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

  return {
    id: "flue",
    async run(input: CodingAgentInput): Promise<CodingAgentOutput> {
      try {
        const { start } = await client.dispatchAndStart(toDispatchBody(input), {
          taskId: input.metadata.task_id,
        });
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
