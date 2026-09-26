/**
 * Workflow SkillLoader (EVE-2).
 *
 * Allow-list = the workflow step's `skills_allowed` intersected with the global
 * index (`skills/index.json`). `from_planner_selection` uses the planner's ids
 * as that step list. Explicit step lists stay as written so a later step is not
 * emptied by another step's selection.
 *
 * `seed` symlinks only those skills into `<worktree>/.agents/skills` from the
 * control-plane checkout (SPEC §6.5 — reference the SoT, do not fork bodies).
 * `loadSkill` is the harness gate for the agent-loop tool `load_skill`.
 */
import { lstat, mkdir, readFile, readdir, readlink, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";

export const FROM_PLANNER_SELECTION = "from_planner_selection";

const SkillsAllowedSchema = z.union([
  z.literal(FROM_PLANNER_SELECTION),
  z.array(z.string().min(1)),
]);

const WorkflowSchema = z
  .object({
    steps: z
      .array(
        z
          .object({
            id: z.string().min(1),
            skills_allowed: SkillsAllowedSchema,
          })
          .passthrough(),
      )
      .min(1),
  })
  .passthrough();

const IndexSchema = z
  .object({
    skills: z.array(
      z
        .object({
          id: z.string().min(1),
          cursor_native_id: z.string().min(1),
          cursor_native_path: z.string().min(1),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export class SkillBudgetDeniedError extends Error {
  readonly code = "SKILL_BUDGET_DENIED" as const;
  readonly skillId: string;

  constructor(skillId: string) {
    super(
      skillId
        ? `load_skill denied: ${skillId} is outside the active skill budget`
        : "load_skill denied: outside the active skill budget",
    );
    this.name = "SkillBudgetDeniedError";
    this.skillId = skillId;
  }
}

export interface WorkflowLoadedSkill {
  id: string;
  /** Absolute path of the live SoT skill directory on the control-plane checkout. */
  sourcePath: string;
  body: string;
}

export interface ComputeAllowListInput {
  stepId: string;
  plannerSelection?: readonly string[];
}

export interface WorkflowSkillLoader {
  computeAllowList(input: ComputeAllowListInput): Promise<readonly string[]>;
  seed(worktreePath: string, allowList: readonly string[]): Promise<void>;
  reap(worktreePath: string): Promise<void>;
  loadSkill(skillId: string, budget: readonly string[]): Promise<WorkflowLoadedSkill>;
}

export interface WorkflowSkillLoaderOptions {
  /** Control-plane checkout. Defaults to `process.cwd()`. */
  repoRoot?: string;
  workflowPath?: string;
  indexPath?: string;
}

interface StepBudget {
  id: string;
  skillsAllowed: readonly string[] | typeof FROM_PLANNER_SELECTION;
}

interface IndexEntry {
  id: string;
  cursorNativeId: string;
  cursorNativePath: string;
}

interface Catalog {
  steps: Map<string, StepBudget>;
  entries: IndexEntry[];
  byId: Map<string, IndexEntry>;
}

export function createWorkflowSkillLoader(
  options?: WorkflowSkillLoaderOptions,
): WorkflowSkillLoader {
  const repoRoot = path.resolve(options?.repoRoot ?? process.cwd());
  const workflowPath =
    options?.workflowPath ?? path.join(repoRoot, "workflows", "default-task.yaml");
  const indexPath = options?.indexPath ?? path.join(repoRoot, "skills", "index.json");
  let catalog: Catalog | undefined;

  async function loadCatalog(): Promise<Catalog> {
    if (catalog) return catalog;
    const [workflowRaw, indexRaw] = await Promise.all([
      readFile(workflowPath, "utf8"),
      readFile(indexPath, "utf8"),
    ]);
    const workflow = WorkflowSchema.safeParse(parse(workflowRaw));
    if (!workflow.success) {
      throw new Error(`invalid workflow ${workflowPath}: ${workflow.error.message}`);
    }
    let indexJson: unknown;
    try {
      indexJson = JSON.parse(indexRaw);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`invalid skill index ${indexPath}: ${message}`);
    }
    const index = IndexSchema.safeParse(indexJson);
    if (!index.success) {
      throw new Error(`invalid skill index ${indexPath}: ${index.error.message}`);
    }

    const steps = new Map<string, StepBudget>();
    for (const step of workflow.data.steps) {
      steps.set(step.id, { id: step.id, skillsAllowed: step.skills_allowed });
    }
    const entries = index.data.skills.map((skill) => {
      assertSkillPath(skill.cursor_native_path);
      assertNativeId(skill.cursor_native_id);
      return {
        id: skill.id,
        cursorNativeId: skill.cursor_native_id,
        cursorNativePath: skill.cursor_native_path,
      };
    });
    catalog = {
      steps,
      entries,
      byId: new Map(entries.map((entry) => [entry.id, entry])),
    };
    return catalog;
  }

  return {
    async computeAllowList(input) {
      const loaded = await loadCatalog();
      const step = loaded.steps.get(input.stepId);
      if (!step) {
        throw new Error(`unknown workflow step ${input.stepId}`);
      }
      const global = new Set(loaded.entries.map((entry) => entry.id));
      const candidates =
        step.skillsAllowed === FROM_PLANNER_SELECTION
          ? [...(input.plannerSelection ?? [])]
          : [...step.skillsAllowed];
      const allowed: string[] = [];
      const seen = new Set<string>();
      for (const id of candidates) {
        if (seen.has(id) || !global.has(id)) continue;
        seen.add(id);
        allowed.push(id);
      }
      return allowed;
    },

    async seed(worktreePath, allowList) {
      const loaded = await loadCatalog();
      const selected: IndexEntry[] = [];
      for (const id of allowList) {
        const entry = loaded.byId.get(id);
        if (!entry) {
          throw new Error(`cannot seed ${id}: outside the global allow-list`);
        }
        const source = sourcePath(repoRoot, entry);
        try {
          await lstat(source);
        } catch (error) {
          if (isEnoent(error)) {
            throw new Error(`skill source missing for ${id}: ${source}`);
          }
          throw error;
        }
        selected.push(entry);
      }

      const destRoot = path.join(worktreePath, ".agents", "skills");
      await mkdir(destRoot, { recursive: true });
      const keep = new Set(selected.map((entry) => entry.cursorNativeId));
      for (const name of await readdir(destRoot)) {
        if (!keep.has(name)) {
          await rm(path.join(destRoot, name), { recursive: true, force: true });
        }
      }
      for (const entry of selected) {
        await placeLink(sourcePath(repoRoot, entry), path.join(destRoot, entry.cursorNativeId));
      }
    },

    async reap(worktreePath) {
      await rm(path.join(worktreePath, ".agents", "skills"), { recursive: true, force: true });
    },

    async loadSkill(skillId, budget) {
      const loaded = await loadCatalog();
      const entry = loaded.byId.get(skillId);
      if (!budget.includes(skillId) || !entry) {
        throw new SkillBudgetDeniedError(skillId);
      }
      const absolute = sourcePath(repoRoot, entry);
      const body = await readFile(path.join(absolute, "SKILL.md"), "utf8");
      return { id: skillId, sourcePath: absolute, body };
    },
  };
}

function sourcePath(repoRoot: string, entry: IndexEntry): string {
  return path.resolve(repoRoot, entry.cursorNativePath);
}

function assertSkillPath(skillPath: string): void {
  if (path.isAbsolute(skillPath) || skillPath.split(/[/\\]/).includes("..")) {
    throw new Error(`skill path escapes the repo: ${skillPath}`);
  }
}

function assertNativeId(id: string): void {
  if (id === "." || id === ".." || !/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new Error(`skill id cannot name a directory: ${id}`);
  }
}

async function placeLink(source: string, dest: string): Promise<void> {
  try {
    const stat = await lstat(dest);
    if (stat.isSymbolicLink()) {
      const current = await readlink(dest);
      if (path.resolve(current) === path.resolve(source)) return;
    }
    await rm(dest, { recursive: true, force: true });
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
  await symlink(source, dest, "dir");
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
