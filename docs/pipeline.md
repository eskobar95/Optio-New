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

`GET /hello` is the hello-world card for that first stage. `GET /hello/plan` reports the plan cursor (`queued` until a worker writes it, `progressed: true` when status is `completed`). `runHelloWorldPlan` is the same intake → plan path in memory, used by Vitest when Redis is absent. `scripts/hello-world-e2e.sh` posts intake against a live orchestrator and polls `/hello/plan`. On the kit-harness host: `docker compose --profile full --profile harness up -d --build orchestrator`, then `HELLO_WORLD_E2E=1 bash scripts/hello-world-e2e.sh`.

## Step cursor

Table `pipeline_step_cursor` (`state/migrations/001_pipeline_step_cursor.sql`), keyed by `(task_id, session_id, stage)`.

| Column            | Meaning                                        |
| ----------------- | ---------------------------------------------- |
| `next_step_index` | First intra-stage step that has not been saved |
| `status`          | `pending`, `running`, `completed`, or `failed` |

Steps, in order:

- plan: `ack_session`, `invoke_planner`
- implement: `invoke_implementation`, `record_diff`

`invoke_implementation` on the Cursor adapter appends the implement feedback policy (syntax-checked edits, truncated search and list summaries, empty-command observations). See [cursor-implement-feedback.md](cursor-implement-feedback.md).

- review: `invoke_review`, `record_verdict`
- ready: `open_pr`, `record_ci_wait`
- merge: `merge_branch`, `record_cleanup`

The handler runs, then the cursor advances. If the process dies or the cursor write throws, the next delivery runs that same step again and skips steps whose index was already saved. A finished stage does not call the handler again. A later stage throws `StageNotReadyError` until the previous stage is `completed`.

`createAgentStageHandler(adapter)` calls `runAgentLoop` once per step (`${stage}:${step} task=${taskId}`). The adapter is injected. `createEnvModelAdapter` performs no HTTP.

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

`adapter` is any `ModelAdapter`. `createEnvModelAdapter()` reads `MODEL_API_KEY` and `MODEL_ENDPOINT` and performs no HTTP.

## Live orchestrator

The Compose `orchestrator` service (profiles `full` and `orchestrator`) runs `src/orchestrator/main.ts`. It listens on `ORCHESTRATOR_PORT` (3100), requires `OPTIO_NEW_REDIS_URL` and `OPTIO_NEW_DATABASE_URL`, and starts one BullMQ worker per stage queue. `GET /health` reports the Redis ping. `POST /intake` enqueues the plan stage. The worker handler is `createProductionStageHandler`, with `WorktreeManager` on implement and merge.

Compose interpolates these names from the env file into `orchestrator` and `eve-runner` (`${VAR:-}`, empty when unset):

| Name                              | Role                                                                                          |
| --------------------------------- | --------------------------------------------------------------------------------------------- |
| `CURSOR_API_KEY`                  | Cursor coding agent (`resolveCodingBackend` defaults to `cursor`, then `createCursorAdapter`) |
| `OPTIO_NEW_GITHUB_TOKEN`          | Push the task branch and call the GitHub pull request API                                     |
| `OPTIO_NEW_GITHUB_REPO`           | `owner/repo` for that API                                                                     |
| `MODEL_API_KEY`, `MODEL_ENDPOINT` | Planner fallback only. The env adapter performs no HTTP                                       |
| `OPTIO_NEW_BASE_BRANCH`           | Worktree base and pull request base. Default `development`                                    |

Inside the container, `OPTIO_NEW_REPO_PATH` is `/opt/optio-new` and `OPTIO_NEW_WORKTREE_ROOT` is `/var/lib/optio-new/worktrees` (volume `optio_new_worktrees`). The host side of the checkout mount is `${OPTIO_NEW_REPO_PATH:-/opt/optio-new}`. `OPTIO_NEW_WORKTREE_RETAIN_ON_FAILURE` defaults to `true`; `false` removes the named `wt-<task>` directory when merge fails.

`CURSOR_AGENT_BIN` is passed through when set. The image installs `git` and does not download the Cursor CLI. A missing `agent` binary fails the coding step with `cli_not_found`.

| Step                                     | What the process does                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ack_session`, `record_cleanup`          | Bookkeeping. `record_cleanup` still reaps via `createWorktreeStageHandler`                                                                                                                                                                                                                                                  |
| `invoke_planner`                         | With `CURSOR_API_KEY`: Cursor agent in a new task worktree. Without it: requires `MODEL_API_KEY` and `MODEL_ENDPOINT`, then `createAgentStageHandler(createEnvModelAdapter())`, which throws `StageCredentialsError` because that adapter performs no HTTP                                                                  |
| `invoke_implementation`, `invoke_review` | Cursor agent in the worktree. Missing `CURSOR_API_KEY` throws `StageCredentialsError`. Any non-succeeded adapter status fails the job                                                                                                                                                                                       |
| `record_diff`, `record_verdict`          | `git status --short` in the worktree                                                                                                                                                                                                                                                                                        |
| `open_pr`                                | Optional e2e marker when the branch has no commits ahead of the base, then the PR safety gate, then push `task/<id>` and open a GitHub pull request. Tests, lint, and typecheck must exit 0. The diff review blocks secrets and destructive changes. A closed gate does not push. Other empty branches fail before the gate |
| `record_ci_wait`                         | One combined commit status. Anything other than `success` fails the attempt so BullMQ can retry                                                                                                                                                                                                                             |
| `merge_branch`                           | PR safety gate again, then merge the pull request. A closed gate does not merge. Task ids matching `e2e-…` stay unmerged after the gate passes                                                                                                                                                                              |

The container runs as root so it can register worktrees on the host checkout mounted at `/opt/optio-new`. Worktree directories use the `optio_new_worktrees` volume.

Host proof (does not merge):

```bash
cd /opt/optio-new
bash scripts/secrets.sh compose --profile orchestrator up -d --build orchestrator
INTAKE_PR_E2E=1 bash scripts/secrets.sh run -- bash scripts/intake-pr-e2e.sh
```

`scripts/intake-pr-e2e.sh` posts `{ brief, metadata.taskId }` with an `e2e-` id and polls GitHub for an open pull request whose head is `task/<id>`. It skips unless `INTAKE_PR_E2E=1`. Close that pull request when you are done. `scripts/hello-world-e2e.sh` still polls plan completion; planner now runs this handler, so that check needs `CURSOR_API_KEY` and the `agent` binary.

Apply `state/migrations/001_pipeline_step_cursor.sql` before using Postgres. `createPgStepCursorStore` also runs that DDL on connect.

## Spans

Each `processStageJob` call emits `workflow.step` with `task_id`, `worktree_id` (empty until a worktree exists; later stages read it from `WorktreeManager.status`), `workflow_id=default-task`, and `step_id` set to the stage. The agent handler nests `agent.run` and `skill.load` under that span. A new checkout emits `worktree.create`. Deleting it emits `worktree.remove`. Export to Langfuse or SigNoz stays off unless the env flag is `true`. See `docs/observability.md` and `docs/ops/worktree-isolation.md`.

## Run log

`StageRuntime.runLog` records one row per task, session, and stage (`pipeline_stage_run`, `state/migrations/003_pipeline_stage_run.sql`). The row has `startedAt`, `endedAt`, and `durationMs`. A thrown step stores `status: failed`, the error message as `reason`, and an `error` action for that step. Token or cost figures are stored only when the model adapter or coding agent reported them. `GET /tasks/:taskId/actions` on the orchestrator returns that view. Reading a failed run: `docs/ops/read-failed-run.md`.

## Tests

`npm test` covers the happy path and crash resume with in-memory and SQL-executor cursors. It does not need Redis, Postgres, or `MODEL_API_KEY`.

The harness regression suite (`npm run eval`, also part of `npm test`) runs fixture tasks from intake through the production stage handler. CI mocks the Cursor CLI and `open_pr`. See [ops/harness-eval.md](ops/harness-eval.md).

Optional:

- `OPTIO_NEW_REDIS_URL` — enqueue the flow and let workers drain it
- `OPTIO_NEW_DATABASE_URL` — crash/resume against Postgres

## Learning queue

`optio.learn` is a side queue, not a pipeline stage. Review-gate failures and implementation handler failures can be enqueued there. The consumer fingerprints them and, past `OPTIO_LEARN_THRESHOLD`, files a `meta/self-improve` proposal. It does not rewrite gates. See [learning-worker.md](learning-worker.md).
