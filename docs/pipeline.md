# Pipeline graph (BullMQ)

SPEC §14.0. BullMQ on Redis is the orchestrator. New Bot only decides and enqueues. This skeleton does not call Linear, Vercel Workflows, Inngest, or Temporal.

## Queues

| Stage     | Queue             | Runs after |
| --------- | ----------------- | ---------- |
| plan      | `optio.plan`      | intake     |
| implement | `optio.implement` | plan       |
| review    | `optio.review`    | implement  |
| ready     | `optio.ready`     | review     |
| merge     | `optio.merge`     | ready      |

`buildPipelineFlow({ taskId, sessionId })` returns a BullMQ flow whose root is `optio.merge` and whose leaf is `optio.plan`. Children run first, so each parent waits on the previous stage. Job id is `${sessionId}__${stage}` (BullMQ rejects `:` in custom ids, so ids cannot contain `:`). Failed jobs retry (`attempts: 5`, exponential backoff).

`enqueueIntakePipeline(input, flowProducer)` runs `buildIntakeJob` and enqueues that flow. `sessionId` defaults to `taskId`.

`POST /intake` (`createIntakeServer`) is the HTTP entry. It accepts `{ brief, metadata }`, then calls `enqueueIntakePipeline`. The `202` body returns `jobId` `${sessionId}__plan` on queue `optio.plan`. Invalid bodies return `400` and do not enqueue. See `orchestrator/intake/README.md`.

## Step cursor

Table `pipeline_step_cursor` (`state/migrations/001_pipeline_step_cursor.sql`), keyed by `(task_id, session_id, stage)`.

| Column            | Meaning                                        |
| ----------------- | ---------------------------------------------- |
| `next_step_index` | First intra-stage step that has not been saved |
| `status`          | `pending`, `running`, `completed`, or `failed` |

Steps, in order:

- plan: `ack_session`, `invoke_planner`
- implement: `invoke_implementation`, `record_diff`
- review: `invoke_review`, `record_verdict`
- ready: `open_pr`, `record_ci_wait`
- merge: `merge_branch`, `record_cleanup`

The handler runs, then the cursor advances. If the process dies or the cursor write throws, the next delivery runs that same step again and skips steps whose index was already saved. A finished stage does not call the handler again. A later stage throws `StageNotReadyError` until the previous stage is `completed`.

`createAgentStageHandler(adapter)` calls `runAgentLoop` once per step (`${stage}:${step} task=${taskId}`). The adapter is injected. `createEnvModelAdapter` still does not perform HTTP.

Optional `StageRuntime.worktrees` (`WorktreeManager`) hooks the implement and merge stages:

- `implement` / `invoke_implementation` calls `create(taskId)` before the step handler.
- `merge` / `merge_branch` failure calls `reap(taskId, { merged: false })`. The manager keeps the directory when `retainOnFailure` is true (the default) and removes it when that flag is false.
- `merge` / `record_cleanup` calls `reap(taskId, { merged: true })` after the step handler returns.

## Workers

Symbols are exported from `src/index.ts`.

```ts
const cursors = process.env.OPTIO_NEW_DATABASE_URL
  ? await createPgStepCursorStore(process.env.OPTIO_NEW_DATABASE_URL)
  : new InMemoryStepCursorStore();

const worktrees = new WorktreeManager({
  root: "/var/lib/optio-new/worktrees",
  repoPath: "/opt/optio-new",
  baseBranch: "development",
  retainOnFailure: true,
});

const workers = startStageGraph(
  { cursors, handler: createAgentStageHandler(adapter), worktrees },
  bullmqStageWorkerFactory({
    url: process.env.OPTIO_NEW_REDIS_URL,
    maxRetriesPerRequest: null,
  }),
);
```

`adapter` is any `ModelAdapter`. `createEnvModelAdapter()` reads `MODEL_API_KEY` and `MODEL_ENDPOINT` and still does not perform HTTP.

Apply `state/migrations/001_pipeline_step_cursor.sql` before using Postgres. `createPgStepCursorStore` also runs that DDL on connect.

## Spans

Each `processStageJob` call emits `workflow.step` with `task_id`, `worktree_id` (empty until a worktree exists), `workflow_id=default-task`, and `step_id` set to the stage. The agent handler nests `agent.run` and `skill.load` under that span. Export to Langfuse or SigNoz stays off unless the env flag is `true`. See `docs/observability.md`.

## Tests

`npm test` covers the happy path and crash resume with in-memory and SQL-executor cursors. It does not need Redis, Postgres, or `MODEL_API_KEY`.

Optional:

- `OPTIO_NEW_REDIS_URL` — enqueue the flow and let workers drain it
- `OPTIO_NEW_DATABASE_URL` — crash/resume against Postgres
