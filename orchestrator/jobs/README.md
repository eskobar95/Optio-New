# orchestrator/jobs

BullMQ workers backed by Redis. Durable job steps for the default pipeline. Runnable TypeScript lives in `src/orchestrator/jobs/`.

## Architectural decision

**BullMQ is the official orchestrator** for the full issue-to-merge pipeline (intake → plan → implement → review → ready → merge). Each stage is a job that waits on the previous stage; crashed jobs resume from the Postgres step cursor (`state/migrations/001_pipeline_step_cursor.sql`). **Vercel is AI Gateway only** — do not use Vercel Workflows/WDK here. See SPEC §14.0 and `docs/pipeline.md`.

## Queues

`optio.plan` → `optio.implement` → `optio.review` → `optio.ready` → `optio.merge`

`buildPipelineFlow` builds the BullMQ flow (plan is the child that runs first). Job ids are `${sessionId}__${stage}` because BullMQ rejects `:`. `processStageJob` is the idempotent handler and emits a `workflow.step` span. `startStageGraph` registers one worker per queue. Pass `worktrees` on the stage runtime to create a checkout on implement and reap it on merge (`src/orchestrator/worktrees/`).

Unit tests use `InMemoryStepCursorStore` or `createSqlStepCursorStore`. Pass `OPTIO_NEW_REDIS_URL` / `OPTIO_NEW_DATABASE_URL` only when you want the optional integration tests.
