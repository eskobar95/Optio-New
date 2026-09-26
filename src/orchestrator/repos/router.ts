/**
 * Routes worktree create/reap to the checkout named by repoId.
 * ResourceGuard runs before a new worktree is added.
 */
import {
  ResourceGuard,
  loadResourceThresholds,
  readDockerDataRoot,
  type ResourceGuardOptions,
} from "../resources/guard.js";
import { createHostResourceProbe } from "../resources/probe.js";
import type { StageTracer } from "../telemetry/index.js";
import { loadWorktreeRuntimeConfig } from "../worktrees/config.js";
import {
  WorktreeManager,
  type CreateWorktreeOptions,
  type ReapResult,
  type WorktreeHandle,
  type WorktreeLifecycle,
  type WorktreeReapOutcome,
  type WorktreeSkillStageHook,
} from "../worktrees/manager.js";
import { loadRepoCatalog, resolveRepo, type RepoBinding, type RepoCatalog } from "./catalog.js";

export interface RoutedWorktree extends WorktreeLifecycle {
  status(taskId: string): Promise<WorktreeHandle | undefined>;
}

type ManagedWorktree = WorktreeLifecycle & {
  status?(taskId: string): Promise<WorktreeHandle | undefined>;
};

export interface RepoWorktreeRouterOptions {
  catalog: RepoCatalog;
  retainOnFailure?: boolean;
  skillStageHook?: WorktreeSkillStageHook;
  guard?: ResourceGuard;
  tracer?: StageTracer;
  createManager?: (binding: RepoBinding) => ManagedWorktree;
}

export class RepoWorktreeRouter implements RoutedWorktree {
  private readonly catalog: RepoCatalog;
  private readonly retainOnFailure: boolean | undefined;
  private readonly skillStageHook: WorktreeSkillStageHook | undefined;
  private readonly guard: ResourceGuard | undefined;
  private readonly tracer: StageTracer | undefined;
  private readonly createManager: (binding: RepoBinding) => ManagedWorktree;
  private readonly managers = new Map<string, ManagedWorktree>();

  constructor(options: RepoWorktreeRouterOptions) {
    this.catalog = options.catalog;
    this.retainOnFailure = options.retainOnFailure;
    this.skillStageHook = options.skillStageHook;
    this.guard = options.guard;
    this.tracer = options.tracer;
    this.createManager =
      options.createManager ??
      ((binding) =>
        new WorktreeManager({
          root: binding.worktreeRoot,
          repoPath: binding.localPath,
          baseBranch: binding.defaultBranch,
          retainOnFailure: this.retainOnFailure,
          skillStageHook: this.skillStageHook,
          tracer: this.tracer,
        }));
  }

  async create(taskId: string, options?: CreateWorktreeOptions): Promise<WorktreeHandle> {
    const binding = resolveRepo(this.catalog, options?.repoId);
    const manager = this.managerFor(binding);
    const existing = manager.status ? await manager.status(taskId) : undefined;
    if (!existing && this.guard) {
      await this.guard.assertCanCreate({ taskId, worktreeRoot: binding.worktreeRoot });
    }
    return manager.create(taskId, options);
  }

  async status(taskId: string): Promise<WorktreeHandle | undefined> {
    for (const binding of this.catalog.repos) {
      const manager = this.managerFor(binding);
      if (!manager.status) continue;
      const handle = await manager.status(taskId);
      if (handle) return handle;
    }
    return undefined;
  }

  async reap(taskId: string, outcome: WorktreeReapOutcome): Promise<ReapResult> {
    for (const binding of this.catalog.repos) {
      const manager = this.managerFor(binding);
      if (!manager.status) continue;
      const handle = await manager.status(taskId);
      if (handle) return manager.reap(taskId, outcome);
    }
    return this.managerFor(resolveRepo(this.catalog)).reap(taskId, outcome);
  }

  private managerFor(binding: RepoBinding): ManagedWorktree {
    const existing = this.managers.get(binding.repoId);
    if (existing) return existing;
    const created = this.createManager(binding);
    this.managers.set(binding.repoId, created);
    return created;
  }
}

export function createGuardedRepoWorktrees(
  env: NodeJS.ProcessEnv = process.env,
  options?: { catalog?: RepoCatalog; guard?: ResourceGuard; tracer?: StageTracer },
): RepoWorktreeRouter {
  const catalog = options?.catalog ?? loadRepoCatalog(env);
  const runtime = loadWorktreeRuntimeConfig(env);
  const guard =
    options?.guard ??
    new ResourceGuard({
      thresholds: loadResourceThresholds(env),
      dockerDataRoot: readDockerDataRoot(env),
      probe: createHostResourceProbe(),
    } satisfies ResourceGuardOptions);
  return new RepoWorktreeRouter({
    catalog,
    guard,
    retainOnFailure: runtime.retainOnFailure,
    tracer: options?.tracer,
  });
}
