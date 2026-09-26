# orchestrator/intake

**New Bot** (Grok Bot) is the decision and intake layer for Optio-New.

## Role

- Accept tasks from chat or `POST /intake`, not from Linear Agent Sessions.
- Enqueue BullMQ jobs for the default pipeline: plan → implement → review → ready → merge (`enqueueIntakePipeline` in `src/orchestrator/jobs/`).
- Surface elicitations and status back to New Bot / the human in chat.

## HTTP

`createIntakeServer` (`src/orchestrator/intake/http.ts`) serves `POST /intake`. The process entry is `src/orchestrator/main.ts` (image `Dockerfile.orchestrator`, `ORCHESTRATOR_PORT`, default 3100). `GET /health` is 200 when Redis answers `PING`.

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

Public Caddy still proxies only `/webhooks/*`. This route stays on the orchestrator listener until signature verification exists. Do not expose it without that check.

## Explicitly out (v1)

- Linear webhooks, GraphQL, OAuth agent scopes, Agent Activities.
- Backlog polling of any issue tracker as the control plane.

## Still later

Signature verification before a public Caddy `/webhooks/*` route can enqueue work.

See `docs/SPEC.md` §8 (intake) and §14.0 (BullMQ).
