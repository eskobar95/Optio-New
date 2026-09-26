# orchestrator/jobs

BullMQ workers backed by Redis. Durable job steps for the default pipeline. Runnable TypeScript lives in `src/orchestrator/jobs/`.

## Architectural decision

**BullMQ is the official orchestrator** for the full issue-to-merge pipeline (intake → plan → implement → review → ready → merge). Each stage is a job that waits on the previous stage; crashed jobs resume from the Postgres step cursor (`state/migrations/001_pipeline_step_cursor.sql`). **Vercel is AI Gateway only** — do not use Vercel Workflows/WDK here. See SPEC §14.0 and `docs/pipeline.md`.

## Queues

`optio.plan` → `optio.implement` → `optio.review` → `optio.ready` → `optio.merge`

`buildPipelineFlow` builds the BullMQ flow (plan is the child that runs first). Job ids are `${sessionId}__${stage}` because BullMQ rejects `:`. `processStageJob` is the idempotent handler and emits a `workflow.step` span. `startStageGraph` registers one worker per queue. The Compose entrypoint `src/orchestrator/main.ts` starts that graph against Redis and the Postgres cursor. It builds `WorktreeManager` from `OPTIO_NEW_WORKTREE_ROOT` (default `/var/lib/optio-new/worktrees`) and `OPTIO_NEW_REPO_PATH` (default `/opt/optio-new`) and passes that manager on the stage runtime. Implement creates `wt-<task>` before `invoke_implementation`. Merge calls `reap({ merged: false })` when `merge_branch` throws, and `reap({ merged: true })` after `record_cleanup`. The image installs git and mounts the host checkout. v1 uses those git worktrees, not a container per task. Disk budget on the CX33 host: `docs/ops/worktree-isolation.md`.

Unit tests use `InMemoryStepCursorStore` or `createSqlStepCursorStore`. Pass `OPTIO_NEW_REDIS_URL` / `OPTIO_NEW_DATABASE_URL` only when you want the optional integration tests.
