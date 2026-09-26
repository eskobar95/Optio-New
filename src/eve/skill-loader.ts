/**
 * Eve skill budget (EVE-2).
 *
 * `load_skill` hard-denies ids outside the active allow-list: the step's
 * `skills_allowed` (or the planner selection) intersected with the global
 * allow-list. Allowed skills are symlinked into the worktree at
 * `.agents/skills/<id>` from the control-plane checkout. `WorktreeManager`
 * still owns git worktree create/delete; a later hook can call
 * {@link EveWorktreeSkillSeed}.
 */
import { lstat, mkdir, readFile, rm, stat, symlink } from "node:fs/promises";
import path from "node:path";

const SKILL_ID = /^skills\/[A-Za-z0-9][A-Za-z0-9_-]*$/;
const NATIVE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export interface EveSkillIndexEntry {
  id: string;
  cursorNativeId: string;
  cursorNativePath: string;
}

export interface EveSkillBody {
  id: string;
  body: string;
  sourcePath: string;
}

export interface EveSkillLoaderOptions {
  sourceRoot: string;
  index: readonly EveSkillIndexEntry[];
  globalAllowList: readonly string[];
}

export interface SkillAllowListInput {
  skillsAllowed: readonly string[] | "from_planner_selection";
  plannerSelection?: readonly string[];
}

export class SkillBudgetDeniedError extends Error {
  readonly code = "skill_budget_denied" as const;
  readonly skillId: string;

  constructor(skillId: string) {
    super(`load_skill denied: ${skillId} is outside the skill budget`);
    this.name = "SkillBudgetDeniedError";
    this.skillId = skillId;
  }
}

export class SkillNotIndexedError extends Error {
  readonly code = "skill_not_indexed" as const;
  readonly skillId: string;

  constructor(skillId: string) {
    super(`load_skill denied: ${skillId} is not in the skill index`);
    this.name = "SkillNotIndexedError";
    this.skillId = skillId;
  }
}

export function parseSkillIndex(document: unknown): EveSkillIndexEntry[] {
  if (!document || typeof document !== "object" || !("skills" in document)) {
    throw new Error("skill index is missing skills");
  }
  const skills = (document as { skills: unknown }).skills;
  if (!Array.isArray(skills)) {
    throw new Error("skill index skills must be an array");
  }
  const seen = new Set<string>();
  return skills.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`skill index entry ${index} is invalid`);
    }
    const row = entry as Record<string, unknown>;
    const id = row.id;
    const cursorNativeId = row.cursor_native_id;
    const cursorNativePath = row.cursor_native_path;
    if (
      typeof id !== "string" ||
      typeof cursorNativeId !== "string" ||
      typeof cursorNativePath !== "string"
    ) {
      throw new Error(`skill index entry ${index} is missing id fields`);
    }
    if (
      !SKILL_ID.test(id) ||
      !NATIVE_ID.test(cursorNativeId) ||
      id !== `skills/${cursorNativeId}`
    ) {
      throw new Error(`skill index entry ${index} has an invalid id`);
    }
    const expectedPath = `.cursor/skills/${cursorNativeId}`;
    if (cursorNativePath !== expectedPath) {
      throw new Error(`skill index entry ${id} path must be ${expectedPath}`);
    }
    if (seen.has(id)) {
      throw new Error(`skill index lists ${id} more than once`);
    }
    seen.add(id);
    return { id, cursorNativeId, cursorNativePath };
  });
}

export class EveSkillLoader {
  private readonly sourceRoot: string;
  private readonly index: ReadonlyMap<string, EveSkillIndexEntry>;
  private readonly globalAllowList: ReadonlySet<string>;

  constructor(options: EveSkillLoaderOptions) {
    if (!options.sourceRoot.trim()) throw new Error("skill source root is required");
    this.sourceRoot = path.resolve(options.sourceRoot);
    this.index = new Map(options.index.map((entry) => [entry.id, entry]));
    this.globalAllowList = new Set(options.globalAllowList);
  }

  resolveAllowList(input: SkillAllowListInput): string[] {
    const candidates =
      input.skillsAllowed === "from_planner_selection"
        ? (input.plannerSelection ?? [])
        : input.skillsAllowed;
    const seen = new Set<string>();
    const allowList: string[] = [];
    for (const id of candidates) {
      if (!this.globalAllowList.has(id) || seen.has(id)) continue;
      seen.add(id);
      allowList.push(id);
    }
    return allowList;
  }

  async loadSkill(skillId: string, activeBudget: readonly string[]): Promise<EveSkillBody> {
    if (!activeBudget.includes(skillId)) {
      throw new SkillBudgetDeniedError(skillId);
    }
    const entry = this.index.get(skillId);
    if (!entry) {
      throw new SkillNotIndexedError(skillId);
    }
    const sourcePath = path.join(this.skillDirectory(entry), "SKILL.md");
    const body = await readFile(sourcePath, "utf8");
    return { id: skillId, body, sourcePath };
  }

  async materialize(worktreePath: string, allowList: readonly string[]): Promise<void> {
    const worktree = await this.existingDirectory(worktreePath);
    this.assertSeparateFromSource(worktree);
    for (const skillId of allowList) {
      const entry = this.index.get(skillId);
      if (!entry) throw new SkillNotIndexedError(skillId);
      const target = this.skillDirectory(entry);
      await this.existingDirectory(target);
      const linkPath = path.join(worktree, ".agents", "skills", entry.cursorNativeId);
      assertInside(worktree, linkPath);
      await mkdir(path.dirname(linkPath), { recursive: true });
      await replaceSkillSymlink(linkPath, path.relative(path.dirname(linkPath), target));
    }
  }

  async reapMaterialized(worktreePath: string): Promise<void> {
    const worktree = await this.existingDirectory(worktreePath);
    const skillsDir = path.join(worktree, ".agents", "skills");
    assertInside(worktree, skillsDir);
    await rm(skillsDir, { recursive: true, force: true });
  }

  private skillDirectory(entry: EveSkillIndexEntry): string {
    return assertInside(this.sourceRoot, path.resolve(this.sourceRoot, entry.cursorNativePath));
  }

  private assertSeparateFromSource(worktree: string): void {
    if (isInside(this.sourceRoot, worktree) || isInside(worktree, this.sourceRoot)) {
      throw new Error("skill source and worktree must be separate directories");
    }
  }

  private async existingDirectory(target: string): Promise<string> {
    const absolute = path.resolve(target);
    let info;
    try {
      info = await stat(absolute);
    } catch (error) {
      if (isEnoent(error)) throw new Error(`${absolute} does not exist`);
      throw error;
    }
    if (!info.isDirectory()) throw new Error(`${absolute} is not a directory`);
    return absolute;
  }
}

function assertInside(root: string, candidate: string): string {
  const absolute = path.resolve(candidate);
  const relative = path.relative(root, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${absolute} is outside ${root}`);
  }
  return absolute;
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function replaceSkillSymlink(linkPath: string, relativeTarget: string): Promise<void> {
  try {
    const info = await lstat(linkPath);
    if (!info.isSymbolicLink()) {
      throw new Error(`${linkPath} exists and is not a skill symlink`);
    }
    await rm(linkPath);
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
  await symlink(relativeTarget, linkPath, "dir");
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
