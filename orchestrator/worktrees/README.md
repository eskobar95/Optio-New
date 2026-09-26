# orchestrator/worktrees

Create / status / remove git worktrees keyed by **task id**. Runnable TypeScript: `src/orchestrator/worktrees/`.

`new WorktreeManager({ root, repoPath, baseBranch: "development", retainOnFailure: true })`

- `create(taskId)` adds `wt-<task>` under `root` on branch `task/<task>` cut from the configured base (pass `origin/development` when that ref is the base). The returned `{ worktreeId, path }` is absolute and unique per task.
- One path per task. A second task whose id sanitizes to the same key is rejected. `writeFile` cannot leave that task's directory.
- Sparse-checkout omits `.cursor/skills`, `.cursor/agents`, `.cursor/commands`, and `.cursor/rules` (§6.5).
- `reap(taskId, { merged: true })` removes the worktree and local branch. `{ merged: false }` keeps it while `retainOnFailure` is true.
- With a `tracer`, a new checkout emits `worktree.create` and a real delete emits `worktree.remove`. Both spans carry `task_id` and `worktree_id`. A second `create` for the same task does not emit again. A retained failure does not emit `worktree.remove`.

`createWorktreeManagerFromEnv` reads `OPTIO_NEW_WORKTREE_ROOT`, `OPTIO_NEW_REPO_PATH`, `OPTIO_NEW_BASE_BRANCH`, and `OPTIO_NEW_WORKTREE_RETAIN_ON_FAILURE` (`true` or `false`, default `true`). The orchestrator process passes `getStageTracer()`.

BullMQ: pass the manager as `StageRuntime.worktrees`. Implement calls `create` before `invoke_implementation` and stores `worktreeId` on the step context. Merge calls `reap({ merged: false })` when `merge_branch` throws, and `reap({ merged: true })` after `record_cleanup`.

CX33 disk budget and why v1 does not use a container per task: `docs/ops/worktree-isolation.md`.

Session concurrency (SPEC §13.5, `src/orchestrator/sessions`) does not create or reap git worktrees. It claims a cwd through `SessionWorkspacePort`. Adapt this manager with `workspacePortFromWorktreeManager`. Releasing a session drops that claim only. Reap stays on merge success.

## More than one repo

`RepoWorktreeRouter` (`src/orchestrator/repos/router.ts`) implements the same `create` / `status` / `reap` surface. `create(taskId, { repoId })` uses that binding's `localPath`, `defaultBranch`, and `worktreeRoot`. Omitted `repoId` uses the catalog default. The orchestrator process builds this router with `createGuardedRepoWorktrees`, so a low disk, inode, or memory reading throws `ResourceGuardError` before `git worktree add`. See [docs/ops/multi-repo-cx33.md](../../docs/ops/multi-repo-cx33.md) and [docs/ops/resource-guard.md](../../docs/ops/resource-guard.md).
