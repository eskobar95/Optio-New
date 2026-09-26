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

The handler runs, then the cursor advances. If the process dies or the cursor write throws, the next delivery runs that same step again and skips steps whose index was already saved. A thrown step is saved as `failed` at the same index. A finished stage does not call the handler again. A later stage throws `StageNotReadyError` until the previous stage is `completed`.

`readStageCheckpoint` reports `lastCompletedStage` and `resumeStage` from those rows. A restarted orchestrator continues at `resumeStage`. Re-running `open_pr` reuses the recorded pull request. Re-running implement reuses the task worktree, including when the lock file was lost after `git worktree add`. Operators: [docs/ops/crash-recovery.md](ops/crash-recovery.md). Host proof: `bash scripts/chaos-resume-implement.sh`.

## Session artifacts

When `StageRuntime.artifacts` is set, each stage upserts one row in `session_artifacts` (`state/migrations/004_session_artifacts.sql`): stage name, outcome, plan text, pull request URL, and the last error. `GET /tasks/:taskId/artifacts` and `scripts/dump-session-artifacts.sh` print that trail. Retention defaults suit a CX33 80 GB disk (14 days, 16 KiB, 2000 rows). See [docs/ops/session-artifacts.md](ops/session-artifacts.md).

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

// Multi-repo plus the CX33 disk/memory guard. `main.ts` uses this helper.
// const worktrees = createGuardedRepoWorktrees(process.env);

const workers = startStageGraph(
  { cursors, handler: createAgentStageHandler(adapter), worktrees },
  bullmqStageWorkerFactory({
    url: process.env.OPTIO_NEW_REDIS_URL,
    maxRetriesPerRequest: null,
  }),
);
```

`adapter` is any `ModelAdapter`. `createEnvModelAdapter()` reads `MODEL_API_KEY` and `MODEL_ENDPOINT` and performs no HTTP.

## Human approval and task caps

`StageRuntime.hitl` pauses `implement` until plan is approved, and pauses `ready` before `open_pr` (the same decision also covers `merge`). Default modes are `when_confidence_low` for plan and `always` for merge. Timeout notifies once and does not approve. `POST /approvals` with `approve`, `reject`, or `replan` wakes the BullMQ job. Reject and replan do not reap the worktree. See [hitl.md](hitl.md).

`StageRuntime.budget` checks token and USD caps before and after `invoke_planner`, `invoke_implementation`, and `invoke_review`. A miss or an overage throws `BudgetExceeded` and does not start later stages. Defaults are 200000 tokens and USD 2. `GET /budget` shows the caps and the ledger. See [task-budget.md](task-budget.md).

## Live orchestrator

The Compose `orchestrator` service (profiles `full` and `orchestrator`) runs `src/orchestrator/main.ts`. It listens on `ORCHESTRATOR_PORT` (3100), requires `OPTIO_NEW_REDIS_URL` and `OPTIO_NEW_DATABASE_URL`, and starts one BullMQ worker per stage queue. `GET /health` reports the Redis ping. `POST /intake` enqueues the plan stage. The worker handler is `createProductionStageHandler`, with `WorktreeManager` on implement and merge.

Compose interpolates these names from the env file into `orchestrator` and `eve-runner` (`${VAR:-}`, empty when unset):

| Name                                     | Role                                                                                            |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `CURSOR_API_KEY`                         | Cursor coding agent (`resolveCodingBackend` defaults to `cursor`, then `createCursorAdapter`)   |
| `OPTIO_NEW_GITHUB_TOKEN`                 | Push the task branch and call the GitHub pull request API                                       |
| `OPTIO_NEW_GITHUB_REPO`                  | `owner/repo` when `OPTIO_NEW_REPOS` is empty. A catalog task uses that `repoId`'s clone URL     |
| `OPTIO_NEW_LINEAR_API_KEY`               | Linear `commentCreate` (`queued`) after an enabled team's status-change intake                  |
| `OPTIO_NEW_LINEAR_WEBHOOK_SECRET`        | HMAC for `POST /webhooks/linear`                                                                |
| `OPTIO_NEW_LINEAR_DEFAULT_REPO_ID`       | Overrides the team's `defaultRepoId` from `config/linear-projects.yaml` (ENG: `findjobabroad`)  |
| `OPTIO_NEW_LINEAR_PROJECTS_CONFIG`       | Optional path to that file. Unset uses `config/linear-projects.yaml`                            |
| `LINEAR_WORKFLOW_CI_FAIL_ESCALATE_AFTER` | Failed CI/Review attempts before a Linear escape hatch. Default `3`                             |
| `MODEL_API_KEY`, `MODEL_ENDPOINT`        | Planner fallback only. The env adapter performs no HTTP                                         |
| `OPTIO_NEW_BASE_BRANCH`                  | Base branch for the synthetic catalog. A `OPTIO_NEW_REPOS` binding uses its own `defaultBranch` |

`OPTIO_NEW_LINEAR_API_KEY`, `OPTIO_NEW_LINEAR_WEBHOOK_SECRET`, `OPTIO_NEW_LINEAR_DEFAULT_REPO_ID`, `OPTIO_NEW_LINEAR_PROJECTS_CONFIG`, and `LINEAR_WORKFLOW_CI_FAIL_ESCALATE_AFTER` are passed only to the `orchestrator` service. The image copies `config/linear-projects.yaml` to `/app/config/linear-projects.yaml`. An empty projects-config env keeps that path.

Inside the container, `OPTIO_NEW_REPO_PATH` is `/opt/optio-new` and `OPTIO_NEW_WORKTREE_ROOT` is `/var/lib/optio-new/worktrees` (volume `optio_new_worktrees`). The host side of the checkout mount is `${OPTIO_NEW_REPO_PATH:-/opt/optio-new}`. `OPTIO_NEW_WORKTREE_RETAIN_ON_FAILURE` defaults to `true`; `false` removes the named `wt-<task>` directory when merge fails.

`CURSOR_AGENT_BIN` is passed through when set. Empty keeps the `agent` binary baked into `Dockerfile.orchestrator`. A missing binary fails the coding step with `cli_not_found`.

The orchestrator image is Debian bookworm (glibc), not Alpine. Alpine cannot run the Cursor CLI (`fcntl64`, then `cli_not_found`). The image build downloads the CLI with `curl -fsS https://cursor.com/install` into `/opt/cursor-cli` and links `/usr/local/bin/agent`. That script does not take `CURSOR_API_KEY`. The key stays in the sops env file and Compose injects it at runtime. Rebuild the image to pick up a newer CLI. `eve-runner` stays on Alpine and does not bake `agent`.

Inside that container, `OPTIO_CURSOR_SANDBOX` is the literal `disabled`. The adapter keeps the permission-tier flags and rewrites `--sandbox enabled` to `--sandbox disabled` (allowlist mode), including on `--force` implement steps, so Docker AppArmor does not reject Cursor's user-namespace sandbox. Host and dev runs leave the variable unset, so the tier table in [permission-tiers.md](permission-tiers.md) stays in effect.

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

Apply `state/migrations/001_pipeline_step_cursor.sql`, `state/migrations/003_pipeline_stage_run.sql`, and `state/migrations/004_session_artifacts.sql` before using Postgres. `openOrchestratorDatabase` runs the cursor and session-artifact DDL on connect. `createPgStageRunStore` runs the stage-run DDL. `createPgStepCursorStore` still runs only the cursor DDL.

## Spans

Each `processStageJob` call emits `workflow.step` with `task_id`, `worktree_id` (empty until a worktree exists; later stages read it from `WorktreeManager.status`), `workflow_id=default-task`, and `step_id` set to the stage. The agent handler nests `agent.run` and `skill.load` under that span. A new checkout emits `worktree.create`. Deleting it emits `worktree.remove`. Export to Langfuse or SigNoz stays off unless the env flag is `true`. See `docs/observability.md` and `docs/ops/worktree-isolation.md`.

## Run log

`StageRuntime.runLog` records one row per task, session, and stage (`pipeline_stage_run`, `state/migrations/003_pipeline_stage_run.sql`). The row has `startedAt`, `endedAt`, and `durationMs`. A thrown step stores `status: failed`, the error message as `reason`, and an `error` action for that step. Token or cost figures are stored only when the model adapter or coding agent reported them. `GET /tasks/:taskId/actions` on the orchestrator returns that view. Reading a failed run: `docs/ops/read-failed-run.md`.

## Tests

`npm test` covers the happy path, crash resume, worktree and pull-request replay, the artifact trail, and a SIGKILL during implement. It does not need Redis, Postgres, or `MODEL_API_KEY`.

The harness regression suite (`npm run eval`, also part of `npm test`) runs fixture tasks from intake through the production stage handler. CI mocks the Cursor CLI and `open_pr`. See [ops/harness-eval.md](ops/harness-eval.md).

Optional:

- `OPTIO_NEW_REDIS_URL` — enqueue the flow and let workers drain it
- `OPTIO_NEW_DATABASE_URL` — crash/resume against Postgres

## Learning queue

`optio.learn` is a side queue, not a pipeline stage. Review-gate failures and implementation handler failures can be enqueued there. The consumer fingerprints them and, past `OPTIO_LEARN_THRESHOLD`, files a `meta/self-improve` proposal. It does not rewrite gates. See [learning-worker.md](learning-worker.md).
