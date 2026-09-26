/**
 * Specialist invoke for the implementation step.
 *
 * EVE-3 eve-runner (#60) is not on main. This is the plug: the runner passes
 * its step payload as `parent` and an optional executor. The result goes back
 * to that parent. This module does not read or write the BullMQ step cursor.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CANONICAL_SPAN, type StageTracer } from "../telemetry/index.js";
import {
  IMPLEMENTATION_AGENT_ID,
  IMPLEMENTATION_STEP_ID,
  isStepAdvanceTool,
  specialistSkillBudget,
  specialistToolBudget,
} from "./budget.js";
import {
  isSpecialistId,
  loadSpecialistCatalog,
  type SpecialistCatalog,
  type SpecialistId,
} from "./catalog.js";

export const SPECIALIST_ADVANCE_INPUT_KEYS = [
  "advanceStep",
  "nextStep",
  "enqueue",
  "cursor",
  "stepAdvanced",
] as const;

export class SpecialistInvokeError extends Error {
  readonly code:
    | "parent_step_forbidden"
    | "unknown_specialist"
    | "specialist_not_allowed"
    | "step_advance_denied"
    | "tool_denied";

  constructor(
    message: string,
    code:
      | "parent_step_forbidden"
      | "unknown_specialist"
      | "specialist_not_allowed"
      | "step_advance_denied"
      | "tool_denied",
  ) {
    super(message);
    this.name = "SpecialistInvokeError";
    this.code = code;
  }
}

/** Parent step. Field names match the EVE-3 eve-runner input contract. */
export const EveRunnerStepSchema = z.object({
  taskId: z.string().min(1),
  stepId: z.string().min(1),
  worktreePath: z.string().min(1),
  agentId: z.string().min(1),
  skillBudget: z.array(z.string()),
  specialistsAllowed: z.array(z.string()),
  history: z
    .array(
      z.object({
        role: z.string(),
        content: z.string(),
      }),
    )
    .optional(),
  tools: z.array(z.string()).optional(),
  worktreeId: z.string().min(1).optional(),
});

export type EveRunnerStep = z.infer<typeof EveRunnerStepSchema>;

const SpecialistInvokeSchema = z.object({
  parent: EveRunnerStepSchema,
  specialistId: z.string().min(1),
  task: z.string().min(1),
});

export interface SpecialistRunRequest {
  sessionId: string;
  specialistId: SpecialistId;
  task: string;
  worktreePath: string;
  systemPrompt: string;
  skillBudget: readonly string[];
  allowedTools: readonly string[];
  /** Fresh conversation. Parent turns are not copied. */
  messages: readonly [];
}

export type SpecialistExecutor = (request: SpecialistRunRequest) => Promise<{ summary: string }>;

export interface SpecialistInvokeOptions {
  execute?: SpecialistExecutor;
  catalog?: SpecialistCatalog;
  tracer?: StageTracer;
  now?: () => Date;
  sessionId?: () => string;
  root?: string;
}

export interface SpecialistInvokeResult {
  specialistId: SpecialistId;
  sessionId: string;
  createdAt: string;
  worktreePath: string;
  sharedWorktree: true;
  messages: readonly [];
  skillBudget: readonly string[];
  allowedTools: readonly string[];
  systemPrompt: string;
  summary: string;
  /** Always false. The orchestrator owns BullMQ transitions. */
  stepAdvanced: false;
  parent: {
    taskId: string;
    stepId: string;
    agentId: string;
  };
}

export async function invokeSpecialist(
  input: unknown,
  options: SpecialistInvokeOptions = {},
): Promise<SpecialistInvokeResult> {
  rejectAdvanceKeys(input);
  const parsed = SpecialistInvokeSchema.parse(input);
  const run = () => prepareSpecialist(parsed, options);
  if (!options.tracer) return run();
  return options.tracer.runStage(
    CANONICAL_SPAN.specialistCall,
    {
      taskId: parsed.parent.taskId,
      worktreeId: parsed.parent.worktreeId ?? "",
      attributes: {
        specialist_id: parsed.specialistId,
        step_id: parsed.parent.stepId,
        agent_id: parsed.parent.agentId,
        worktree_path: parsed.parent.worktreePath,
      },
    },
    run,
  );
}

export function dispatchSpecialistTool(
  session: { allowedTools: readonly string[] },
  tool: string,
): { ok: true; tool: string } {
  if (isStepAdvanceTool(tool)) {
    throw new SpecialistInvokeError(
      `specialist cannot call ${tool}; the orchestrator owns BullMQ transitions`,
      "step_advance_denied",
    );
  }
  if (!session.allowedTools.includes(tool)) {
    throw new SpecialistInvokeError(
      `tool ${tool} is outside the specialist allow-list`,
      "tool_denied",
    );
  }
  return { ok: true, tool };
}

async function prepareSpecialist(
  input: z.infer<typeof SpecialistInvokeSchema>,
  options: SpecialistInvokeOptions,
): Promise<SpecialistInvokeResult> {
  const parent = input.parent;
  if (parent.stepId !== IMPLEMENTATION_STEP_ID || parent.agentId !== IMPLEMENTATION_AGENT_ID) {
    throw new SpecialistInvokeError(
      "only the implementation step may invoke a specialist",
      "parent_step_forbidden",
    );
  }
  if (!isSpecialistId(input.specialistId)) {
    throw new SpecialistInvokeError(
      `unknown specialist ${input.specialistId}`,
      "unknown_specialist",
    );
  }

  const catalog = options.catalog ?? (await loadSpecialistCatalog(options.root));
  const record = catalog.get(input.specialistId);
  if (!record) {
    throw new SpecialistInvokeError(
      `unknown specialist ${input.specialistId}`,
      "unknown_specialist",
    );
  }
  if (!catalog.implementationAllowed.includes(record.id)) {
    throw new SpecialistInvokeError(
      `${record.id} is not on the implementation workflow allow-list`,
      "specialist_not_allowed",
    );
  }
  if (!parent.specialistsAllowed.includes(record.id)) {
    throw new SpecialistInvokeError(
      `${record.id} is not allowed for this implementation step`,
      "specialist_not_allowed",
    );
  }

  const allowedTools = specialistToolBudget(record.tools, parent.tools);
  const skillBudget = specialistSkillBudget(record.skills, parent.skillBudget);
  const messages: readonly [] = [];
  const request: SpecialistRunRequest = {
    sessionId: options.sessionId ? options.sessionId() : randomUUID(),
    specialistId: record.id,
    task: input.task,
    worktreePath: parent.worktreePath,
    systemPrompt: systemPrompt(record.instructions),
    skillBudget,
    allowedTools,
    messages,
  };

  const executed = options.execute ? await options.execute(request) : undefined;
  return {
    specialistId: request.specialistId,
    sessionId: request.sessionId,
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
    worktreePath: parent.worktreePath,
    sharedWorktree: true,
    messages,
    skillBudget,
    allowedTools,
    systemPrompt: request.systemPrompt,
    summary: executed?.summary ?? "returned to parent",
    stepAdvanced: false,
    parent: {
      taskId: parent.taskId,
      stepId: parent.stepId,
      agentId: parent.agentId,
    },
  };
}

function systemPrompt(instructions: string): string {
  return [
    instructions.trim(),
    "",
    "Shared worktree: write only inside the parent worktree path.",
    "Fresh session: you have no prior conversation.",
    "Return the result to the parent implementation agent.",
    "Do not advance the workflow. The orchestrator owns transitions.",
  ].join("\n");
}

function rejectAdvanceKeys(input: unknown): void {
  if (!input || typeof input !== "object") return;
  const record = input as Record<string, unknown>;
  for (const key of SPECIALIST_ADVANCE_INPUT_KEYS) {
    if (key in record) {
      throw new SpecialistInvokeError(
        `specialist invoke cannot accept ${key}; the orchestrator owns transitions`,
        "step_advance_denied",
      );
    }
  }
  const parent = record.parent;
  if (!parent || typeof parent !== "object") return;
  for (const key of SPECIALIST_ADVANCE_INPUT_KEYS) {
    if (key in parent) {
      throw new SpecialistInvokeError(
        `specialist invoke cannot accept parent.${key}; the orchestrator owns transitions`,
        "step_advance_denied",
      );
    }
  }
}
