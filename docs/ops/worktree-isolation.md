# Worktree isolation on the CX33 host

SPEC §7 and §6.5. v1 gives each task its own git worktree. The orchestrator does not start a container per task.

The kit-harness host is a Hetzner **CX33**: 4 shared vCPU, 8 GB RAM, 80 GB NVMe. The figures below are a planning budget for that disk, not a live `df` of the box. A guard that refuses `create` when free space is low is issue #95.

## What runs

`src/orchestrator/main.ts` builds `WorktreeManager` with `createWorktreeManagerFromEnv` and passes it on the BullMQ stage runtime.

| Variable                               | Container value                | Meaning                                                                                                      |
| -------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `OPTIO_NEW_REPO_PATH`                  | `/opt/optio-new`               | Checkout that owns branches and worktree registrations. Host mount: `${OPTIO_NEW_REPO_PATH:-/opt/optio-new}` |
| `OPTIO_NEW_WORKTREE_ROOT`              | `/var/lib/optio-new/worktrees` | Named checkouts. Compose volume `optio_new_worktrees`                                                        |
| `OPTIO_NEW_BASE_BRANCH`                | `development` unless set       | Branch each new worktree is cut from                                                                         |
| `OPTIO_NEW_WORKTREE_RETAIN_ON_FAILURE` | `true` unless set to `false`   | `true` keeps `wt-<task>` when merge fails. `false` deletes that directory                                    |

Lifecycle:

1. `implement` / `invoke_implementation` calls `create(taskId)` before the step handler. The CodingAgent `worktree_path` is that checkout. Two tasks get `wt-<task-a>` and `wt-<task-b>` with ids `wt-<task-a>` and `wt-<task-b>`.
2. Sparse-checkout omits `.cursor/skills`, `.cursor/agents`, `.cursor/commands`, and `.cursor/rules`. Coding CLIs do not auto-ingest the Cursor-native source of truth. Eve still loads skills by id from the control-plane checkout.
3. Review, ready, and merge keep using the same directory. `status(taskId)` supplies `worktree_id` on later `workflow.step` spans.
4. `merge_branch` failure calls `reap(taskId, { merged: false })`. With the default retain flag the named directory stays. A later successful merge still reaps it.
5. `record_cleanup` runs only after `merge_branch` returns. It follows `.cursor/skills/reap-worktree`: delete the remote issue branch with `git push --delete` when the task tip is on the base and the worktree is clean, then `reap(taskId, { merged: true })` removes the worktree and the local `task/<id>` branch. Reject, conflict fallback, and a failed merge throw before `record_cleanup`, and `reap({ merged: false })` keeps the directory.
6. Every checkout is `wt-<key>` plus `.locks/<key>.json`. Reap deletes the lock. There is no unnamed directory. SPEC’s `orphaned/` archive is not used; retain keeps the named path, and `retainOnFailure=false` removes it.

Session release (`src/orchestrator/sessions`) drops a cwd claim only. It does not reap.

## Disk budget (80 GB)

Git worktrees share the object database in `/opt/optio-new`. Each `wt-<task>` is a working tree, not a second clone. This repo’s source tree is tens of megabytes. `npm ci` inside a worktree is the costly case: plan about **1 GB per task** when an agent installs dependencies. The manager does not install dependencies itself.

| Use                                                                             | Plan        |
| ------------------------------------------------------------------------------- | ----------- |
| Host OS, packages, Docker                                                       | 8 GB        |
| Images (orchestrator, eve-runner, postgres, redis, litellm, caddy, kit-harness) | 8 GB        |
| Postgres and Redis volumes                                                      | 5 GB        |
| Checkout at `/opt/optio-new`, including one `node_modules`                      | 2 GB        |
| Free headroom (do not fill the disk)                                            | 10 GB       |
| Remainder for `optio_new_worktrees`                                             | about 45 GB |

Default session caps are one Cursor run and one Codex run, so two live coding directories. Retained failures are the growth risk: each kept tree stays until merge reap or a reap with `retainOnFailure` false. At roughly 1 GB per installed tree, 45 GB is on the order of a few dozen retained tasks, and far fewer if checkouts stay source-only.

`docker compose down -v` deletes the Postgres volume and the worktree volume. The boot unit’s `ExecStop` does not pass `-v`.

A per-task Docker sandbox would put another writable layer on the same 80 GB disk. v1 stays on git worktrees for that reason. Add a Hetzner volume only if retained checkouts outgrow this budget.

## Telemetry

`WorktreeManager` emits these spans when the orchestrator passes `getStageTracer()`:

| Span              | When                                                                          |
| ----------------- | ----------------------------------------------------------------------------- |
| `worktree.create` | A checkout is added. A second `create` for the same task does not emit again. |
| `worktree.remove` | The directory is deleted. A retained failure does not emit.                   |

Both spans set `task_id` and `worktree_id` (`wt-<task>`). Export to Langfuse or SigNoz stays off until the matching env flag is `true`. See `docs/observability.md`.
