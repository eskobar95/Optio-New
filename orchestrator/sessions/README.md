# orchestrator/sessions

Per-provider concurrency for coding-agent runs (SPEC §13.5). Runnable code: `src/orchestrator/sessions`.

- **Caps:** `OPTIO_NEW_CURSOR_MAX_CONCURRENCY` (N) and `OPTIO_NEW_CODEX_MAX_CONCURRENCY` (M). Default is 1 / 1. `0` rejects that provider.
- **Overflow:** `OPTIO_NEW_SESSION_OVERFLOW=queue` parks the caller and grants the oldest `enqueuedAt` first. `reject` returns `codingAgentStatus: rate_limited` and does not queue.
- **Isolation:** a granted session gets one workspace path. Two live sessions cannot share a task id. `writeSessionFile` / `readSessionFile` refuse paths that leave that workspace.
- **Worktrees:** this module does not `git worktree add` or reap. `workspacePortFromWorktreeManager` adapts a manager that implements `create(taskId) → { worktreeId, path }`. `release` drops the claim only (see `orchestrator/worktrees/`).
- **Telemetry:** span `session.queue` and gauge `session.queue_depth`, both with `task_id` and `worktree_id`.
