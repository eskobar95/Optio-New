/**
 * Eve step contract for the local runner (issue #60).
 * The orchestrator owns BullMQ transitions; results never advance the graph.
 */
import { z } from "zod";

export const CodingBackendSchema = z.enum(["cursor", "codex", "sandbox"]);

export const EveStepInputSchema = z.object({
  taskId: z.string().min(1),
  stepId: z.string().min(1),
  worktreePath: z.string().min(1),
  agentId: z.string().regex(/^agents\/[a-z0-9-]+$/, "agentId must be agents/<name>"),
  skillBudget: z.array(z.string().min(1)),
  specialistsAllowed: z.array(z.string().min(1)),
  /** Optional. Env OPTIO_NEW_CODING_BACKEND wins when omitted; default is sandbox. */
  codingBackend: CodingBackendSchema.optional(),
});

export type EveStepInput = z.infer<typeof EveStepInputSchema>;
export type CodingBackend = z.infer<typeof CodingBackendSchema>;

export type GateHint = "pass" | "fail" | "unknown";

export interface EveStepResult {
  ok: boolean;
  /** Always false. Stage transitions stay in the orchestrator. */
  graphAdvanced: false;
  taskId: string;
  stepId: string;
  agentId: string;
  artifacts: {
    systemPrompt: string;
    skillsLoaded: { id: string; path: string }[];
    skillsDenied: { id: string; reason: string }[];
    specialistsAllowed: string[];
    specialistsUnknown: string[];
    allowedTools: string[];
    worktreePath: string;
    adapter: {
      branch?: string;
      diff_summary?: string;
      pr_ready: boolean;
      logs?: string;
      usage: {
        input_tokens?: number;
        output_tokens?: number;
        cached_tokens?: number;
        cost_usd?: number;
        model_id?: string;
        provider: string;
      };
      status: "succeeded" | "failed" | "cancelled" | "budget_exhausted" | "rate_limited";
      error_class?: string;
    };
  };
  exitGateHints: {
    owner: "orchestrator";
    gates: { id: string; hint: GateHint }[];
    notes: string[];
  };
}

export class EveRequestError extends Error {
  readonly statusCode: number;
  readonly errorClass: string;

  constructor(statusCode: number, errorClass: string, message: string) {
    super(message);
    this.name = "EveRequestError";
    this.statusCode = statusCode;
    this.errorClass = errorClass;
  }
}
