/**
 * Run exactly one Eve step. Does not enqueue BullMQ work or advance the graph.
 */
import { realpathSync } from "node:fs";
import path from "node:path";
import type {
  CodingAgent,
  CodingAgentOutput,
  CodingAgentStatus,
} from "../adapters/coding-agent.js";
import { createCodingAgent } from "../adapters/select.js";
import {
  assembleSystemPrompt,
  findRepoRoot,
  isDirectory,
  loadAgent,
  partitionSpecialists,
  readWorkflowExitGates,
} from "./assemble.js";
import {
  CodingBackendSchema,
  EveRequestError,
  EveStepInputSchema,
  type CodingBackend,
  type EveStepInput,
  type EveStepResult,
  type GateHint,
} from "./contract.js";
import {
  SkillBudgetDeniedError,
  createWorkflowSkillLoader,
  type WorkflowSkillLoader,
} from "../orchestrator/skills/loader.js";
import { createSkillStageHook } from "../orchestrator/worktrees/stage-hooks.js";
import { createWorktreeSandbox } from "./sandbox.js";

export interface EveRunOptions {
  repoRoot?: string;
  adapters?: Partial<Record<CodingBackend, CodingAgent>>;
  skillLoader?: WorkflowSkillLoader;
  env?: NodeJS.ProcessEnv;
}

const sandboxCodingAgent: CodingAgent = {
  id: "sandbox",
  async run(input) {
    const sandbox = createWorktreeSandbox(input.worktree_path);
    return {
      pr_ready: false,
      diff_summary: "sandbox: no worktree mutations",
      logs: `cwd=${sandbox.cwd} tools=${input.allowed_tools.join(",")}`,
      usage: { provider: "sandbox", input_tokens: 0, output_tokens: 0, cost_usd: 0 },
      status: "succeeded",
    };
  },
};

export async function runEveStep(
  raw: unknown,
  options: EveRunOptions = {},
): Promise<EveStepResult> {
  const input = parseInput(raw);
  const repoRoot = options.repoRoot ?? findRepoRoot();
  const worktreePath = resolveWorktree(input.worktreePath);
  const agent = await loadAgent(repoRoot, input.agentId);
  const loader = options.skillLoader ?? createWorkflowSkillLoader({ repoRoot });
  const { loaded, denied } = await loadStepSkills(
    loader,
    input.taskId,
    input.stepId,
    input.skillBudget,
    worktreePath,
    repoRoot,
  );
  const specialists = partitionSpecialists(repoRoot, input.specialistsAllowed);
  const systemPrompt = assembleSystemPrompt({
    taskId: input.taskId,
    stepId: input.stepId,
    agentId: agent.agentId,
    worktreePath,
    instructions: agent.instructions,
    skills: loaded,
    denied,
    specialists: specialists.allowed,
    specialistsUnknown: specialists.unknown,
    tools: agent.tools,
  });
  const env = options.env ?? process.env;
  const backend = resolveBackend(input.codingBackend, env);
  const adapter = options.adapters?.[backend] ?? adapterFor(backend, env);
  const adapterOutput = await invokeAdapter(adapter, {
    worktree_path: worktreePath,
    prompt: `Run one ${input.stepId} step for task ${input.taskId}. Work only in the worktree cwd. Do not advance the workflow graph.`,
    instructions: systemPrompt,
    allowed_tools: [...agent.tools],
    budget: { maxToolRounds: 1 },
    metadata: {
      task_id: input.taskId,
      worktree_id: input.taskId,
      workflow_id: "default-task",
      step_id: input.stepId,
      agent_id: agent.agentId,
    },
  });
  const gates = await readWorkflowExitGates(repoRoot, input.stepId);
  const hint = hintForStatus(adapterOutput.status);
  const notes = ["Orchestrator owns BullMQ transitions; eve-runner does not advance the graph."];
  if (denied.length > 0) notes.push(`Denied ${denied.length} skill load(s).`);
  if (specialists.unknown.length > 0) {
    notes.push(`Unknown specialists: ${specialists.unknown.join(", ")}.`);
  }
  if (gates.length === 0)
    notes.push(`No exit gates for step ${input.stepId} in workflows/default-task.yaml.`);
  if (adapterOutput.status !== "succeeded")
    notes.push(`CodingAgent status ${adapterOutput.status}.`);

  return {
    ok: adapterOutput.status === "succeeded",
    graphAdvanced: false,
    taskId: input.taskId,
    stepId: input.stepId,
    agentId: agent.agentId,
    artifacts: {
      systemPrompt,
      skillsLoaded: loaded.map((skill) => ({ id: skill.id, path: skill.path })),
      skillsDenied: denied.map((skill) => ({ id: skill.id, reason: skill.reason })),
      specialistsAllowed: specialists.allowed,
      specialistsUnknown: specialists.unknown,
      allowedTools: [...agent.tools],
      worktreePath,
      adapter: adapterOutput,
    },
    exitGateHints: {
      owner: "orchestrator",
      gates: gates.map((id) => ({ id, hint })),
      notes,
    },
  };
}

async function loadStepSkills(
  loader: WorkflowSkillLoader,
  taskId: string,
  stepId: string,
  skillBudget: readonly string[],
  worktreePath: string,
  repoRoot: string,
): Promise<{
  loaded: { id: string; path: string; body: string }[];
  denied: { id: string; reason: string }[];
}> {
  let allow: readonly string[] = [];
  try {
    allow = await loader.computeAllowList({ stepId, plannerSelection: skillBudget });
  } catch {
    allow = [];
  }
  const active: string[] = [];
  const denied: { id: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const id of skillBudget) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (allow.includes(id)) active.push(id);
    else denied.push({ id, reason: "outside_budget" });
  }
  await createSkillStageHook(loader).onCreate({
    taskId,
    worktreePath,
    stepId,
    plannerSelection: skillBudget,
  });
  const loaded: { id: string; path: string; body: string }[] = [];
  for (const id of active) {
    try {
      const skill = await loader.loadSkill(id, active);
      loaded.push({
        id: skill.id,
        path: path.relative(repoRoot, path.join(skill.sourcePath, "SKILL.md")),
        body: skill.body,
      });
    } catch (error) {
      if (error instanceof SkillBudgetDeniedError) {
        denied.push({ id, reason: "outside_budget" });
      } else {
        denied.push({ id, reason: "unreadable" });
      }
    }
  }
  return { loaded, denied };
}

function parseInput(raw: unknown): EveStepInput {
  const parsed = EveStepInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new EveRequestError(400, "invalid_input", parsed.error.message);
  }
  return parsed.data;
}

function resolveWorktree(worktreePath: string): string {
  const resolved = path.resolve(worktreePath);
  let cwd: string;
  try {
    cwd = realpathSync(resolved);
  } catch {
    throw new EveRequestError(400, "worktree_not_found", `Worktree not found: ${worktreePath}`);
  }
  if (!isDirectory(cwd)) {
    throw new EveRequestError(
      400,
      "worktree_not_directory",
      `Worktree is not a directory: ${worktreePath}`,
    );
  }
  return cwd;
}

function adapterFor(backend: CodingBackend, env: NodeJS.ProcessEnv): CodingAgent {
  if (backend === "sandbox") return sandboxCodingAgent;
  return createCodingAgent(backend, { env });
}

function resolveBackend(
  explicit: CodingBackend | undefined,
  env: NodeJS.ProcessEnv,
): CodingBackend {
  if (explicit) return explicit;
  const fromEnv = env.OPTIO_NEW_CODING_BACKEND;
  if (fromEnv === undefined || fromEnv === "") return "sandbox";
  const parsed = CodingBackendSchema.safeParse(fromEnv);
  if (!parsed.success) {
    throw new EveRequestError(400, "coding_backend_invalid", `Unknown coding backend "${fromEnv}"`);
  }
  return parsed.data;
}

async function invokeAdapter(
  adapter: CodingAgent,
  input: Parameters<CodingAgent["run"]>[0],
): Promise<CodingAgentOutput> {
  try {
    return await adapter.run(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const notImplemented = message.includes("not implemented");
    return {
      pr_ready: false,
      status: "failed",
      error_class: notImplemented ? "adapter_not_implemented" : "adapter_error",
      logs: message,
      usage: { provider: adapter.id },
    };
  }
}

function hintForStatus(status: CodingAgentStatus): GateHint {
  if (status === "succeeded") return "unknown";
  return "fail";
}
