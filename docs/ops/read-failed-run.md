# Read a failed pipeline run

Each BullMQ stage writes timing, adapter usage, and the steps the agent ran. Failures also print one JSON line on stderr. Langfuse stays optional; this view works while `OPTIO_OTEL_LANGFUSE` is off.

## Logs

A failed stage logs `stage.failed`:

```json
{
  "msg": "stage.failed",
  "taskId": "t-1",
  "sessionId": "s-1",
  "stage": "implement",
  "step": "invoke_implementation",
  "reason": "coding agent cursor failed (cli_failed)",
  "startedAt": "2026-09-26T12:00:00.000Z",
  "endedAt": "2026-09-26T12:00:01.200Z",
  "durationMs": 1200
}
```

`stage` is the pipeline stage (`plan`, `implement`, `review`, `ready`, `merge`). `step` is present when a step handler threw. `reason` is the error message. A finished stage logs `stage.completed` with the same timing fields and no `reason`.

## Inspect one task

On the orchestrator (port 3100):

```bash
curl -sS "http://127.0.0.1:3100/tasks/TASK_ID/actions"
```

The JSON body lists every recorded stage for that `taskId`:

| Field                                | Meaning                                                                                                                                                     |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `startedAt`, `endedAt`, `durationMs` | Stage wall clock. A retry keeps the first `startedAt`.                                                                                                      |
| `status`                             | `running`, `completed`, or `failed`                                                                                                                         |
| `reason`                             | Set when `status` is `failed`                                                                                                                               |
| `usage`                              | Token and cost rows. A row exists only when an adapter reported `input_tokens`, `output_tokens`, `cached_tokens`, or `cost_usd`. Provider alone is omitted. |
| `actions`                            | Each step, `ok` or `error`, with `reason` on error                                                                                                          |

`stages: []` means the task has not recorded a stage. `404` with `Task actions are unavailable` means this process has no run log wired.

Postgres table: `pipeline_stage_run` (`state/migrations/003_pipeline_stage_run.sql`). `createPgStageRunStore` applies that DDL on connect.

When `OPTIO_OTEL_LANGFUSE=true`, the same run is also an OTel trace keyed by `task_id`. Coding-agent spans include `input_tokens`, `output_tokens`, `cached_tokens`, and `cost_usd` when the CLI JSON exposed them.
