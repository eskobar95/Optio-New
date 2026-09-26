/**
 * Load one agent directory and assemble the one-step system prompt.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EveRequestError } from "./contract.js";
import { HARNESS_TOOLS, type HarnessTool } from "./sandbox.js";
interface LoadedSkill {
  id: string;
  path: string;
  body: string;
}

interface DeniedSkill {
  id: string;
  reason: string;
}

export function findRepoRoot(startDir?: string): string {
  let dir = path.resolve(startDir ?? path.dirname(fileURLToPath(import.meta.url)));
  for (let i = 0; i < 8; i += 1) {
    const pkgPath = path.join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string };
        if (pkg.name === "@optio-new/harness") return dir;
      } catch {
        // keep walking
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new EveRequestError(500, "repo_root_not_found", "Could not locate @optio-new/harness");
}

export interface LoadedAgent {
  agentId: string;
  phase: string;
  instructions: string;
  tools: HarnessTool[];
  directory: string;
}

export async function loadAgent(repoRoot: string, agentId: string): Promise<LoadedAgent> {
  const agentsRoot = path.resolve(repoRoot, "agents");
  const directory = path.resolve(repoRoot, agentId);
  const rel = path.relative(agentsRoot, directory);
  if (rel.startsWith("..") || path.isAbsolute(rel) || rel.includes("..")) {
    throw new EveRequestError(400, "agent_id_invalid", `Agent path escapes agents/: ${agentId}`);
  }
  const instructionsPath = path.join(directory, "instructions.md");
  const agentPath = path.join(directory, "agent.ts");
  if (!existsSync(instructionsPath) || !existsSync(agentPath)) {
    throw new EveRequestError(404, "agent_not_found", `Agent directory incomplete: ${agentId}`);
  }
  const [instructions, source] = await Promise.all([
    readFile(instructionsPath, "utf8"),
    readFile(agentPath, "utf8"),
  ]);
  const declared = source.match(/agentId\s*=\s*"([^"]+)"/)?.[1];
  if (declared !== agentId) {
    throw new EveRequestError(
      400,
      "agent_id_mismatch",
      `agent.ts id ${declared ?? "missing"} != ${agentId}`,
    );
  }
  const phase = source.match(/phase:\s*"([^"]+)"/)?.[1] ?? agentId.split("/")[1] ?? agentId;
  return {
    agentId,
    phase,
    instructions,
    tools: await readAgentTools(directory),
    directory,
  };
}

async function readAgentTools(directory: string): Promise<HarnessTool[]> {
  const toolsPath = path.join(directory, "tools.json");
  if (!existsSync(toolsPath)) return [...HARNESS_TOOLS];
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(toolsPath, "utf8"));
  } catch {
    throw new EveRequestError(400, "agent_tools_invalid", `Invalid tools.json in ${directory}`);
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new EveRequestError(400, "agent_tools_invalid", `tools.json must be a string array`);
  }
  const allowed = new Set<string>(HARNESS_TOOLS);
  const tools = parsed.filter((item): item is HarnessTool => allowed.has(item));
  if (tools.length === 0) {
    throw new EveRequestError(400, "agent_tools_invalid", "tools.json has no harness tools");
  }
  return tools;
}

export function readExitGates(workflowYaml: string, stepId: string): string[] {
  const normalized = workflowYaml.replace(/\r\n/g, "\n");
  const chunks = normalized.split(/\n {2}- id: /).slice(1);
  for (const chunk of chunks) {
    const id = chunk.split("\n", 1)[0]?.trim();
    if (id !== stepId) continue;
    const match = chunk.match(/exit_gates:\s*\[([^\]]*)\]/);
    if (!match) return [];
    return match[1]
      .split(",")
      .map((gate) => gate.replace(/#.*/, "").trim())
      .filter(Boolean);
  }
  return [];
}

export async function readWorkflowExitGates(repoRoot: string, stepId: string): Promise<string[]> {
  const workflowPath = path.join(repoRoot, "workflows", "default-task.yaml");
  if (!existsSync(workflowPath)) return [];
  return readExitGates(await readFile(workflowPath, "utf8"), stepId);
}

export function partitionSpecialists(
  repoRoot: string,
  requested: readonly string[],
): { allowed: string[]; unknown: string[] } {
  const indexPath = path.join(repoRoot, "specialists", "index.json");
  let known = new Set<string>();
  if (existsSync(indexPath)) {
    const raw = JSON.parse(readFileSync(indexPath, "utf8")) as { specialists?: { id?: string }[] };
    known = new Set(
      (raw.specialists ?? []).map((entry) => entry.id).filter((id): id is string => Boolean(id)),
    );
  }
  const allowed: string[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();
  for (const id of requested) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (known.has(id)) allowed.push(id);
    else unknown.push(id);
  }
  return { allowed, unknown };
}

export function assembleSystemPrompt(input: {
  taskId: string;
  stepId: string;
  agentId: string;
  worktreePath: string;
  instructions: string;
  skills: LoadedSkill[];
  denied: DeniedSkill[];
  specialists: string[];
  specialistsUnknown: string[];
  tools: readonly string[];
}): string {
  const skillSections = input.skills
    .map((skill) => `## ${skill.id}\n\n${skill.body.trim()}`)
    .join("\n\n");
  const denials =
    input.denied.length === 0
      ? "None."
      : input.denied.map((skill) => `- ${skill.id}: ${skill.reason}`).join("\n");
  const specialists =
    input.specialists.length === 0 ? "None." : input.specialists.map((id) => `- ${id}`).join("\n");
  const unknown =
    input.specialistsUnknown.length === 0
      ? "None."
      : input.specialistsUnknown.map((id) => `- ${id}`).join("\n");
  return [
    "# Eve step",
    `taskId: ${input.taskId}`,
    `stepId: ${input.stepId}`,
    `agentId: ${input.agentId}`,
    `worktree cwd: ${input.worktreePath}`,
    "",
    "Run exactly one step inside the worktree cwd.",
    "The orchestrator owns BullMQ transitions. Do not advance the workflow graph.",
    "",
    "# Agent instructions",
    input.instructions.trim(),
    "",
    "# Loaded skills",
    skillSections || "None.",
    "",
    "# Skill denials",
    denials,
    "",
    "# Specialists allowed",
    specialists,
    "",
    "# Specialists unknown",
    unknown,
    "",
    "# Tools",
    input.tools.join(", "),
    "read_file, write_file, and bash are confined to the worktree cwd.",
    "load_skill hard-denies any id outside the skill budget.",
  ].join("\n");
}

export function isDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}
