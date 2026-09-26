# orchestrator/intake

**New Bot** (Grok Bot) is the decision and intake layer for Optio-New.

## Role

- Accept tasks from chat or `POST /intake`, not from Linear Agent Sessions.
- Enqueue BullMQ jobs for the default pipeline: plan → implement → review → ready → merge (`enqueueIntakePipeline` in `src/orchestrator/jobs/`).
- Surface elicitations and status back to New Bot / the human in chat.

## HTTP

`createIntakeServer` (`src/orchestrator/intake/http.ts`) serves `POST /intake`. The process entry is `src/orchestrator/main.ts` (image `Dockerfile.orchestrator`, `ORCHESTRATOR_PORT`, default 3100). `GET /health` is 200 when Redis answers `PING`. `GET /hello` is the demo card (`hello: "world"`, stage `plan`, queue `optio.plan`). `GET /hello/plan?taskId=&sessionId=` reads the plan step cursor. `sessionId` defaults to `taskId`. `progressed` is true only when that cursor is `completed`. The route is 404 until the process wires a cursor reader. No new port: Compose already publishes 3100 on `127.0.0.1`.

```json
{
  "brief": { "title": "Add intake", "description": "optional" },
  "metadata": {
    "taskId": "t-1",
    "sessionId": "s-1",
    "repo": "eskobar95/Optio-New",
    "baseBranch": "development"
  }
}
```

`title` and `taskId` are required. `sessionId` defaults to `taskId`. `repo` and `baseBranch` are optional hints. Ids must not contain `:`.

A valid body returns `202`:

```json
{ "taskId": "t-1", "sessionId": "s-1", "jobId": "s-1__plan", "queue": "optio.plan" }
```

`jobId` is the first stage job. `enqueueIntakePipeline` adds the whole flow; BullMQ runs `optio.plan` first. Malformed JSON returns `400` with `error: "invalid_json"`. A payload that fails validation returns `400` with `error: "invalid_intake"` and `issues` (`path`, `message`). Nothing is enqueued in either case.

The stage job payload from the pipeline graph is still `{ taskId, sessionId, stage }`. Repo and branch hints are validated here and are not copied onto that payload.

## Public webhook

`POST /webhooks/intake` accepts the same JSON body. It enqueues only when `X-Optio-Signature` is `sha256=` plus the hex HMAC-SHA256 of the raw body, keyed by `OPTIO_NEW_INTAKE_WEBHOOK_SECRET`. A blank secret returns `503` (`webhook_auth_unconfigured`) and does not enqueue. A bad or missing signature returns `401` (`invalid_signature`).

`POST /intake` does not check that header. Keep it on `127.0.0.1:3100`. Caddy profile `edge` proxies `/webhooks/*` on `:80` and does not proxy `/intake`. Enable steps: [docs/ops/caddy-tls-edge.md](../../docs/ops/caddy-tls-edge.md).

## Explicitly out (v1)

- Linear webhooks, GraphQL, OAuth agent scopes, Agent Activities.
- Backlog polling of any issue tracker as the control plane.
- A GitHub webhook receiver on this edge. PR/CI signals stay on `OPTIO_NEW_GITHUB_WEBHOOK_SECRET`.

See `docs/SPEC.md` §8 (intake) and §14.0 (BullMQ).
