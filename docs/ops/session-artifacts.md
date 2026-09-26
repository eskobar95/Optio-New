# Session artifact trail

Each pipeline stage writes one small row for a task, keyed by `(task_id, session_id, stage)`. Operators can dump that trail after the run without reading container logs. The row holds the stage name, the outcome (`completed` or `failed`), markdown body, the plan text (plan stage), the pull request URL (once `open_pr` has one), and the last error message.

The table is `session_artifacts` (`state/migrations/004_session_artifacts.sql`). `openOrchestratorDatabase` applies that DDL on connect, next to the step cursor. Stage timing stays in `003_pipeline_stage_run.sql`.

## Dump

The orchestrator serves the trail on the existing port (3100):

```bash
bash scripts/dump-session-artifacts.sh TASK_ID
bash scripts/dump-session-artifacts.sh TASK_ID SESSION_ID
```

`SESSION_ID` defaults to `TASK_ID`. The script calls `GET /tasks/:taskId/artifacts?sessionId=`. A task with no rows returns an empty trail and HTTP 200. The route is 404 until the process wires a store. `POST` is 405.

Example body:

```json
{
  "taskId": "t-1",
  "sessionId": "s-1",
  "planText": "Ship graph\n\ncut the branch",
  "prUrl": "https://github.com/acme/repo/pull/7",
  "lastError": null,
  "artifacts": []
}
```

`planText` comes from the plan stage (intake title, description, and planner summary). `prUrl` is the latest URL recorded on a stage. `lastError` is the error on the highest failed stage. A later successful retry of that stage clears it.

When the orchestrator process is down, the rows are still in Postgres. From a compiled tree:

```bash
node dist/src/orchestrator/artifacts/main.js --task TASK_ID --session SESSION_ID
```

That command reads `OPTIO_NEW_DATABASE_URL` and prints the same JSON. It does not print the connection string.

## CX33 retention

CX33 is a Hetzner shared-vCPU box: 4 vCPU, 8 GB RAM, and **80 GB NVMe**. That disk also holds the OS, container images, Postgres, Redis, and git worktrees. The trail is not an object store and it does not keep model transcripts, diffs, or docker logs.

| Limit                                | Default | Env                                        |
| ------------------------------------ | ------- | ------------------------------------------ |
| Age                                  | 14 days | `OPTIO_NEW_ARTIFACT_RETENTION_DAYS` (1–90) |
| Bytes per plan, URL, error, and body | 16 KiB  | `OPTIO_NEW_ARTIFACT_MAX_BYTES` (256–65536) |
| Rows on the box                      | 2000    | `OPTIO_NEW_ARTIFACT_MAX_ROWS` (10–20000)   |

2000 rows at 16 KiB is about 32 MB. One row per stage is updated in place, so a replay does not append. The orchestrator prunes after each write: delete rows older than the age limit, then drop the oldest until the row cap holds. Compose passes the three variables into `orchestrator` with those defaults.

Worktrees and Postgres backups are separate. Artifact pruning does not delete `pipeline_step_cursor` or the pull-request ledger under the worktree root. See [crash-recovery.md](crash-recovery.md) and [postgres-storagebox-backup.md](postgres-storagebox-backup.md).
