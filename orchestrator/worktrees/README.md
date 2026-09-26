# orchestrator/worktrees

Create / status / remove git worktrees keyed by **task id**. Runnable TypeScript: `src/orchestrator/worktrees/`.

`new WorktreeManager({ root, repoPath, baseBranch: "development", retainOnFailure: true })`

- `create(taskId)` adds `wt-<task>` under `root` on branch `task/<task>` cut from the configured base (pass `origin/development` when that ref is the base). The returned `{ worktreeId, path }` is absolute and unique per task.
- One path per task. A second task whose id sanitizes to the same key is rejected. `writeFile` cannot leave that task's directory.
- Sparse-checkout omits `.cursor/skills`, `.cursor/agents`, `.cursor/commands`, and `.cursor/rules` (§6.5).
- `reap(taskId, { merged: true })` removes the worktree and local branch. `{ merged: false }` keeps it while `retainOnFailure` is true.

BullMQ: pass the manager as `StageRuntime.worktrees`. Implement calls `create` before `invoke_implementation`. Merge calls `reap({ merged: false })` when `merge_branch` throws, and `reap({ merged: true })` after `record_cleanup`.

Session concurrency (SPEC §13.5, `src/orchestrator/sessions`) does not create or reap git worktrees. It claims a cwd through `SessionWorkspacePort`. Adapt this manager with `workspacePortFromWorktreeManager`. Releasing a session drops that claim only. Reap stays on merge success.
