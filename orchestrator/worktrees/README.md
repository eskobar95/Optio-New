# orchestrator/worktrees

Create / status / remove git worktrees keyed by **task id**. Base branch: latest `origin/development`. Prefer keeping agent cwd inside the worktree; in-repo `.cursor/` skills/agents are the Optio-New SoT (§6.5 / §7).

Session concurrency (SPEC §13.5, `src/orchestrator/sessions`) does not create or reap git worktrees. It claims a cwd through `SessionWorkspacePort`. Implement `WorktreeManagerLike.create(taskId) → { worktreeId, path }` (absolute path, unique per task; throw `WorktreeAlreadyExistsError` on a duplicate) and adapt it with `workspacePortFromWorktreeManager`. Releasing a session drops that claim only. Reap stays on merge success.
