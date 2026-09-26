/**
 * Git worktree lifecycle keyed by task id (SPEC §7, §6.5).
 * One directory per task under the configured root. Merge success removes it;
 * failure keeps it unless `retainOnFailure` is false.
 */
import { execFile } from "node:child_process";
import { access, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** Cursor-native skill / subagent / command / rule trees stay on the control-plane checkout. */
const SOT_EXCLUDES = [
  "!/.cursor/skills/",
  "!/.cursor/agents/",
  "!/.cursor/commands/",
  "!/.cursor/rules/",
] as const;

const repoLocks = new Map<string, Promise<void>>();

export class WorktreeIsolationError extends Error {
  readonly taskId: string;
  readonly path: string;

  constructor(message: string, taskId: string, targetPath: string) {
    super(message);
    this.name = "WorktreeIsolationError";
    this.taskId = taskId;
    this.path = targetPath;
  }
}

export interface WorktreeManagerOptions {
  /** Directory that holds `wt-<task>` checkouts. */
  root: string;
  /** Repository that owns the base branch and the worktree registrations. */
  repoPath: string;
  /** Branch worktrees are cut from. Default `development`. */
  baseBranch?: string;
  /** Keep the checkout when merge did not succeed. Default true. */
  retainOnFailure?: boolean;
}

export interface CreateWorktreeOptions {
  slug?: string;
}

export interface WorktreeHandle {
  taskId: string;
  worktreeId: string;
  path: string;
  branch: string;
}

export interface WorktreeReapOutcome {
  merged: boolean;
}

export interface ReapResult {
  taskId: string;
  action: "reaped" | "retained";
  path: string;
  reason: "merged" | "failure";
}

export interface WorktreeLifecycle {
  create(taskId: string, options?: CreateWorktreeOptions): Promise<WorktreeHandle>;
  reap(taskId: string, outcome: WorktreeReapOutcome): Promise<ReapResult>;
}

interface LockRecord {
  taskId: string;
  branch: string;
  worktreeId: string;
}

interface Layout {
  key: string;
  path: string;
  branch: string;
  worktreeId: string;
  lockPath: string;
}

export function worktreeKey(taskId: string): string {
  const safe = taskId
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!safe || safe === "." || safe === "..") {
    throw new Error(`task id ${JSON.stringify(taskId)} cannot name a worktree`);
  }
  return safe;
}

function withRepoLock<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(repoPath);
  const previous = repoLocks.get(key) ?? Promise.resolve();
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  repoLocks.set(
    key,
    previous.then(
      () => gate,
      () => gate,
    ),
  );
  return previous.then(fn, fn).finally(release);
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function assertInside(root: string, candidate: string, taskId: string): string {
  const absolute = path.resolve(root, candidate);
  const relative = path.relative(root, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new WorktreeIsolationError(
      `task ${taskId} cannot write outside ${root}`,
      taskId,
      absolute,
    );
  }
  return absolute;
}

async function readLock(lockPath: string): Promise<LockRecord | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(lockPath, "utf8"));
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("taskId" in parsed) ||
      !("branch" in parsed) ||
      !("worktreeId" in parsed)
    ) {
      return undefined;
    }
    const record = parsed as LockRecord;
    if (
      typeof record.taskId !== "string" ||
      typeof record.branch !== "string" ||
      typeof record.worktreeId !== "string"
    ) {
      return undefined;
    }
    return record;
  } catch {
    return undefined;
  }
}

function git(cwd: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...args],
      { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (error, _stdout, stderr) => {
        if (error) {
          const detail = stderr.trim() || error.message;
          reject(new Error(`git ${args.join(" ")} (${cwd}): ${detail}`));
          return;
        }
        resolve();
      },
    );
  });
}

export class WorktreeManager implements WorktreeLifecycle {
  private readonly root: string;
  private readonly repoPath: string;
  private readonly baseBranch: string;
  private readonly retainOnFailure: boolean;

  constructor(options: WorktreeManagerOptions) {
    if (!options.root.trim()) throw new Error("worktree root is required");
    if (!options.repoPath.trim()) throw new Error("repoPath is required");
    this.root = path.resolve(options.root);
    this.repoPath = path.resolve(options.repoPath);
    this.baseBranch = options.baseBranch?.trim() || "development";
    this.retainOnFailure = options.retainOnFailure ?? true;
  }

  async create(taskId: string, options?: CreateWorktreeOptions): Promise<WorktreeHandle> {
    const layout = this.layout(taskId, options?.slug);
    return withRepoLock(this.repoPath, async () => {
      const existing = await readLock(layout.lockPath);
      if (existing && existing.taskId !== taskId) {
        throw new WorktreeIsolationError(
          `worktree ${layout.path} is owned by task ${existing.taskId}`,
          taskId,
          layout.path,
        );
      }
      if (existing && (await exists(layout.path))) {
        return {
          taskId,
          path: layout.path,
          branch: existing.branch,
          worktreeId: existing.worktreeId,
        };
      }
      if (await exists(layout.path)) {
        throw new WorktreeIsolationError(`path ${layout.path} already exists`, taskId, layout.path);
      }

      await mkdir(this.root, { recursive: true });
      await git(this.repoPath, ["rev-parse", "--verify", "--quiet", this.baseBranch]);
      const branch = existing?.branch ?? layout.branch;
      if (await this.refExists(`refs/heads/${branch}`)) {
        await git(this.repoPath, ["worktree", "add", layout.path, branch]);
      } else {
        await git(this.repoPath, ["worktree", "add", "-b", branch, layout.path, this.baseBranch]);
      }

      try {
        await git(layout.path, ["sparse-checkout", "set", "--no-cone", "/*", ...SOT_EXCLUDES]);
      } catch (error) {
        await git(this.repoPath, ["worktree", "remove", "--force", layout.path]).catch(
          () => undefined,
        );
        throw error;
      }

      const record: LockRecord = {
        taskId,
        branch,
        worktreeId: layout.worktreeId,
      };
      await mkdir(path.dirname(layout.lockPath), { recursive: true });
      await writeFile(layout.lockPath, `${JSON.stringify(record)}\n`, "utf8");
      return {
        taskId,
        path: layout.path,
        branch,
        worktreeId: layout.worktreeId,
      };
    });
  }

  async status(taskId: string): Promise<WorktreeHandle | undefined> {
    const layout = this.layout(taskId);
    const existing = await readLock(layout.lockPath);
    if (!existing || existing.taskId !== taskId || !(await exists(layout.path))) {
      return undefined;
    }
    return {
      taskId,
      path: layout.path,
      branch: existing.branch,
      worktreeId: existing.worktreeId,
    };
  }

  async writeFile(taskId: string, relativePath: string, contents: string): Promise<void> {
    const handle = await this.status(taskId);
    if (!handle) {
      throw new Error(`no worktree for task ${taskId}`);
    }
    const root = await realpath(handle.path);
    const absolute = assertInside(root, relativePath, taskId);
    const parent = path.dirname(absolute);
    assertInside(root, parent, taskId);
    await mkdir(parent, { recursive: true });
    const realParent = await realpath(parent);
    const realTarget = path.join(realParent, path.basename(absolute));
    assertInside(root, realTarget, taskId);
    await writeFile(realTarget, contents);
  }

  async reap(taskId: string, outcome: WorktreeReapOutcome): Promise<ReapResult> {
    const layout = this.layout(taskId);
    return withRepoLock(this.repoPath, async () => {
      const existing = await readLock(layout.lockPath);
      if (existing && existing.taskId !== taskId) {
        throw new WorktreeIsolationError(
          `cannot reap worktree owned by task ${existing.taskId}`,
          taskId,
          layout.path,
        );
      }
      const present = await exists(layout.path);
      if (!outcome.merged && this.retainOnFailure && present) {
        return { taskId, action: "retained", path: layout.path, reason: "failure" };
      }
      if (present) {
        await git(this.repoPath, ["worktree", "remove", "--force", layout.path]);
        await this.deleteBranch(existing?.branch ?? layout.branch);
      }
      await rm(layout.lockPath, { force: true });
      return {
        taskId,
        action: "reaped",
        path: layout.path,
        reason: outcome.merged ? "merged" : "failure",
      };
    });
  }

  private layout(taskId: string, slug?: string): Layout {
    const key = worktreeKey(taskId);
    const slugKey = slug?.trim() ? worktreeKey(slug) : undefined;
    const branch = slugKey ? `task/${key}-${slugKey}` : `task/${key}`;
    return {
      key,
      path: path.resolve(this.root, `wt-${key}`),
      branch,
      worktreeId: `wt-${key}`,
      lockPath: path.resolve(this.root, ".locks", `${key}.json`),
    };
  }

  private async refExists(ref: string): Promise<boolean> {
    try {
      await git(this.repoPath, ["show-ref", "--verify", "--quiet", ref]);
      return true;
    } catch {
      return false;
    }
  }

  private async deleteBranch(branch: string): Promise<void> {
    try {
      await git(this.repoPath, ["branch", "-D", branch]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/not found/i.test(message)) return;
      throw error;
    }
  }
}
