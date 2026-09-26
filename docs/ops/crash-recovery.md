# Crash recovery

BullMQ retries a stage job after an orchestrator crash, a Redis blip, or a killed worker. Postgres (`pipeline_step_cursor`) is the stage checkpoint. The replacement process reads that table and continues at the unfinished step. Completed stages are not run again.

## Checkpoint

`readStageCheckpoint(cursors, taskId, sessionId)` walks plan → implement → review → ready → merge.

| Field                | Meaning                                                              |
| -------------------- | -------------------------------------------------------------------- |
| `lastCompletedStage` | Latest stage whose cursor is `completed`. Null before plan finishes. |
| `resumeStage`        | First stage that is missing, `running`, or `failed`. Null when done. |

Each stage has two steps. The cursor's `next_step_index` is the first step that was not saved. A crash inside a step leaves `status` as `failed` and does not advance the index, so the retry runs that step again and skips earlier steps.

```sql
SELECT stage, status, next_step_index, updated_at
FROM pipeline_step_cursor
WHERE task_id = 'TASK' AND session_id = 'SESSION'
ORDER BY updated_at;
```

## Idempotent side effects

Re-running a step must not open a second pull request or a second worktree.

- **Implement.** `WorktreeManager.create(taskId)` returns the existing checkout when the lock file is present. If the process dies after `git worktree add` and before the lock is written, the next `create` adopts the registered worktree for `task/<id>` and rewrites the lock. A path that belongs to another branch still throws `WorktreeIsolationError`.
- **open_pr.** The ready step writes `.prs/<task>.json` next to the worktree after GitHub accepts the pull request. A retry that finds that file does not push again and does not `POST /pulls`. If the file is missing but GitHub already has an open pull request for `task/<id>`, the step records that URL and does not create another. A `422` from a raced `POST` looks up the same head and returns it.

`record_ci_wait` still fails the attempt when commit status is not `success`, so BullMQ can retry CI without opening a second pull request.

## Kill during implement

On the host, from the repo root:

```bash
bash scripts/chaos-resume-implement.sh
```

The proof starts a worker, lets plan finish, and sends `SIGKILL` while implement is inside `record_diff`. A second process reads the same cursor and finishes from that step. Plan and `invoke_implementation` do not run again. `npm test` runs the same proof.

The script does not start Compose and does not call GitHub. Production resume uses `OPTIO_NEW_DATABASE_URL` and the same cursor rules.

## After a crash

1. Leave Redis and Postgres up. Do not delete `pipeline_step_cursor` rows for the task.
2. Start the orchestrator again (`docker compose --profile orchestrator up -d orchestrator` on the host). BullMQ redelivers the stalled job. The worker resumes at `resumeStage`.
3. If implement died before the lock file existed, the next attempt adopts the worktree. Do not `git worktree remove` it by hand unless you intend to abandon the task.
4. If `open_pr` died after GitHub created the pull request, the retry reuses it. Close a duplicate only if a race created one before this ledger existed.
5. Read the artifact trail for the plan text, pull request URL, and last error. See [session-artifacts.md](session-artifacts.md).

A finished pipeline is a no-op if the job is delivered again. Failed attempts stay on the unfinished step until they succeed or BullMQ exhausts `attempts` (5).
