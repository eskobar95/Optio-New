/**
 * Optio Run CodingAgent: the Claude CLI driven headless with Jev deciding each
 * action (packages/optio-run in optio-ide). Opt-in: OPTIO_NEW_CODING_BACKEND=optio-run.
 *
 * The permission tier stays the hard ceiling (SPEC §9.1). Inside it, Jev may
 * approve an action; what Jev leaves open goes to kit-harness `decideTool`, and
 * anything that is not an allow is denied, because no person is there to ask.
 *
 * `@optio/run` is loaded on first use, so an image that does not ship it still
 * builds and runs the other backends. Vendor it with `npm pack` for deployment.
 */

import { authorizeAgentRun } from "../../kit-harness/permissions.js";
import { decideTool } from "../../kit-harness/tool-gate.js";
import type { CodingAgent, CodingAgentInput, CodingAgentOutput } from "../coding-agent.js";
import {
  buildAgentPrompt,
  permissionDeniedRun,
  withAgentRunSpan,
  type CodingAgentDeps,
} from "../runtime.js";

/** The part of `@optio/run` this adapter uses. */
export interface OptioRunAction {
  tool: string;
  kind: "read" | "edit" | "execute" | "other";
  action: string;
  input: Record<string, unknown>;
}

export interface OptioRunInput {
  cwd: string;
  prompt: string;
  model?: string;
  access?: "none" | "read" | "full";
  task?: string;
  jev?: { baseUrl?: string; timeoutMs?: number };
  askPerson?: (action: OptioRunAction) => Promise<"allow" | "deny">;
  checkDone?: boolean;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface OptioRunResult {
  status: "succeeded" | "failed" | "cancelled" | "timeout";
  answer: string;
  changed: string[];
  toolCalls: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
  costUsd: number;
  signOffs: { action: string; approve: boolean; reason: string }[];
  done?: { escalate: boolean; unfinished?: number; reason: string };
  error?: string;
}

export type OptioRunFn = (input: OptioRunInput) => Promise<OptioRunResult>;

export interface OptioRunAdapterDeps extends CodingAgentDeps {
  /** Replaces `@optio/run`'s `runClaude` (tests, or a vendored copy). */
  runClaude?: OptioRunFn;
}

const MODULE = "@optio/run";

async function loadRunClaude(): Promise<OptioRunFn> {
  const specifier: string = MODULE;
  const mod = (await import(specifier)) as { runClaude?: OptioRunFn };
  if (typeof mod.runClaude !== "function") throw new Error("@optio/run has no runClaude");
  return mod.runClaude;
}

/** Jev is reachable when a TypeSafe or OpenRouter key is in the environment. */
export function hasJevKey(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    env.OPTIO_NEW_JEV_API_KEY?.trim() || env.JEV_API_KEY?.trim() || env.OPENROUTER_API_KEY?.trim(),
  );
}

function toolNameOf(action: OptioRunAction): string {
  if (action.kind === "execute") return "shell";
  if (action.kind === "edit") return "edit_file";
  return action.tool.toLowerCase();
}

function failure(input: CodingAgentInput, errorClass: string, logs: string): CodingAgentOutput {
  return {
    pr_ready: false,
    status: "failed",
    error_class: errorClass,
    logs,
    usage: { provider: "optio-run", model_id: input.metadata.model_id },
  };
}

function statusOf(result: OptioRunResult): Pick<CodingAgentOutput, "status" | "error_class"> {
  if (result.status === "succeeded") return { status: "succeeded" };
  if (result.status === "timeout") return { status: "budget_exhausted", error_class: "wall_clock" };
  if (result.status === "cancelled") return { status: "cancelled", error_class: "cancelled" };
  const blob = result.error ?? "";
  if (/usage limit|session limit|quota|budget/i.test(blob)) {
    return { status: "budget_exhausted", error_class: "budget_exhausted" };
  }
  if (/\b429\b|rate[_ ]limit/i.test(blob))
    return { status: "rate_limited", error_class: "rate_limited" };
  return { status: "failed", error_class: "cli_failed" };
}

export function createOptioRunAdapter(deps: OptioRunAdapterDeps = {}): CodingAgent {
  return {
    id: "optio-run",
    async run(input: CodingAgentInput): Promise<CodingAgentOutput> {
      return withAgentRunSpan(input, "optio-run", deps.tracer, async () => {
        const auth = authorizeAgentRun({
          allowedTools: input.allowed_tools,
          permissionTier: input.permission_tier,
          stepId: input.metadata.step_id,
        });
        if (!auth.ok) return permissionDeniedRun("optio-run", input, auth.observation);

        let runClaude: OptioRunFn;
        try {
          runClaude = deps.runClaude ?? (await loadRunClaude());
        } catch (error) {
          return failure(
            input,
            "runner_missing",
            error instanceof Error ? error.message : "@optio/run is not installed",
          );
        }

        const env = deps.env ?? process.env;
        const readOnly = auth.tier === "read-only";
        const result = await runClaude({
          cwd: input.worktree_path,
          prompt: buildAgentPrompt(input),
          model: input.metadata.model_id?.trim() || undefined,
          access: readOnly ? "read" : "full",
          task: input.prompt,
          jev: hasJevKey(env) ? {} : undefined,
          checkDone: hasJevKey(env),
          timeoutMs: input.budget.maxWallClockMs,
          env,
          askPerson: async (action) => {
            const verdict = await decideTool(toolNameOf(action), {
              command: action.kind === "execute" ? action.action : undefined,
              path: action.kind === "edit" ? action.action.replace(/^\w+\s+/, "") : undefined,
              agent_id: input.metadata.agent_id,
              step_id: input.metadata.step_id,
              permission_tier: auth.tier,
            });
            return verdict.decision === "allow" ? "allow" : "deny";
          },
        });

        const { status, error_class } = statusOf(result);
        const logs = [
          result.answer,
          result.error ? `error: ${result.error}` : "",
          result.done?.escalate ? `check: unfinished (${result.done.unfinished ?? "?"})` : "",
        ]
          .filter(Boolean)
          .join("\n");
        return {
          pr_ready: status === "succeeded" && result.changed.length > 0,
          diff_summary: result.changed.length > 0 ? result.changed.join("\n") : undefined,
          logs,
          status,
          error_class,
          usage: {
            input_tokens: result.usage.inputTokens,
            output_tokens: result.usage.outputTokens,
            cached_tokens: result.usage.cacheReadTokens,
            cost_usd: result.costUsd,
            model_id: input.metadata.model_id,
            provider: "optio-run",
          },
        };
      });
    },
  };
}

export const optioRunAdapter: CodingAgent = createOptioRunAdapter();

export default optioRunAdapter;
