# orchestrator/intake

**New Bot** (Grok Bot) is the decision and intake layer for Optio-New.

## Role

- Accept tasks from chat or `POST /intake`, not from Linear Agent Sessions.
- Enqueue BullMQ jobs for the default pipeline: plan → implement → review → ready → merge (`enqueueIntakePipeline` in `src/orchestrator/jobs/`).
- Surface elicitations and status back to New Bot / the human in chat.

## HTTP

`createIntakeServer` (`src/orchestrator/intake/http.ts`) serves `POST /intake`. The process entry is `src/orchestrator/main.ts` (image `Dockerfile.orchestrator`, `ORCHESTRATOR_PORT`, default 3100). `GET /health` is 200 when Redis answers `PING`. `GET /hello` is the demo card (`hello: "world"`, stage `plan`, queue `optio.plan`). `GET /hello/plan?taskId=&sessionId=` reads the plan step cursor. `sessionId` defaults to `taskId`. `progressed` is true only when that cursor is `completed`. The route is 404 until the process wires a cursor reader. `GET /tasks/:taskId/actions` returns stage timing, usage, and agent actions for that task. It is 404 until the process wires a run log. `GET /tasks/:taskId/artifacts?sessionId=` dumps the session artifact trail (plan text, pull request URL, last error). It is 404 until a store is wired, and 200 with an empty trail when the task has no rows. No new port: Compose already publishes 3100 on `127.0.0.1`.

```json
{
  "brief": { "title": "Add intake", "description": "optional" },
  "metadata": {
    "taskId": "t-1",
    "sessionId": "s-1",
    "repo": "eskobar95/Optio-New",
    "baseBranch": "development",
    "repoId": "optio-new"
  }
}
```

`title` and `taskId` are required. `sessionId` defaults to `taskId`. `repo` and `baseBranch` are optional hints. `repoId` is an optional catalog selector; omitted uses the workflow `repo_id`, then the catalog default (`default` when `OPTIO_NEW_REPOS` is empty). Ids must not contain `:`. An unknown `repoId` returns `400` `unknown_repo` and does not enqueue.

A valid body returns `202`:

```json
{
  "taskId": "t-1",
  "sessionId": "s-1",
  "jobId": "s-1__plan",
  "queue": "optio.plan",
  "repoId": "default"
}
```

`jobId` is the first stage job. `enqueueIntakePipeline` adds the whole flow; BullMQ runs `optio.plan` first. Malformed JSON returns `400` with `error: "invalid_json"`. A payload that fails validation returns `400` with `error: "invalid_intake"` and `issues` (`path`, `message`). Nothing is enqueued in either case.

`GET /approvals?taskId=&sessionId=` and `POST /approvals` (`point` `plan` or `merge`, `action` `approve`, `reject`, or `replan`) are the human gate. `GET /budget?taskId=&sessionId=` returns the task caps and usage. Both stay 404 until the process wires them. See `docs/hitl.md` and `docs/task-budget.md`.

The stage job payload includes `taskId`, `sessionId`, `stage`, the brief `title` / `description`, and `repoId` when intake resolved one. `repo` and `baseBranch` stay hints and are not copied.

## Public webhook

`POST /webhooks/intake` accepts the same JSON body. It enqueues only when `X-Optio-Signature` is `sha256=` plus the hex HMAC-SHA256 of the raw body, keyed by `OPTIO_NEW_INTAKE_WEBHOOK_SECRET`. A blank secret returns `503` (`webhook_auth_unconfigured`) and does not enqueue. A bad or missing signature returns `401` (`invalid_signature`).

`POST /intake` does not check that header. Keep it on `127.0.0.1:3100`. Caddy profile `edge` proxies `/webhooks/*` on `:80` and does not proxy `/intake`. Enable steps: [docs/ops/caddy-tls-edge.md](../../docs/ops/caddy-tls-edge.md).

## GitHub, Slack, and Linear

`POST /webhooks/github`, `POST /webhooks/slack`, and `POST /webhooks/linear` verify HMAC and enqueue the same `bot.intake.created` flow. Linear accepts Issue status changes for team FIN and then comments `queued`. See [docs/ops/intake-adapters.md](../../docs/ops/intake-adapters.md). Repo routing: [docs/ops/multi-repo-cx33.md](../../docs/ops/multi-repo-cx33.md).

## Explicitly out (v1)

- Linear Agent Sessions, OAuth agent scopes, Agent Activities, and creating or deleting Linear issues. Status-change intake for team FIN is the SPEC §8 exception.
- Backlog polling of any issue tracker as the control plane.

See `docs/SPEC.md` §8 (intake) and §14.0 (BullMQ).
