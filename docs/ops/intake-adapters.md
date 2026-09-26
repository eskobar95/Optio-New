# GitHub, Slack, and Linear intake

Adapters normalize into `bot.intake.created` and call `enqueueIntakePipeline`. SPEC §8: Linear **Agent Sessions** stay out. Linear **intake** is the exception: `POST /webhooks/linear` accepts Issue status changes for team FIN.

## GitHub Issues

`POST /webhooks/github`

- Header `X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of the raw body>`
- Key: `OPTIO_NEW_GITHUB_WEBHOOK_SECRET` (same name as PR/CI). Blank secret → `503` `webhook_auth_unconfigured`. Bad signature → `401` `invalid_signature`. The response does not echo the header or the secret.
- `X-GitHub-Event: issues` and `action: opened`, or `action: labeled` with label `optio`, enqueues. Other events return `202` `{ "accepted": false, "reason": "ignored" }`.
- Task id is `gh-<owner>-<repo>-<number>`. `repository.clone_url` selects `repoId`. One-repo catalogs use the default. A multi-repo catalog with no match returns `400` `unknown_repo`.

## Slack (optional)

`POST /webhooks/slack`

- Headers `X-Slack-Signature: v0=<hex>` and `X-Slack-Request-Timestamp`. The signed base string is `v0:<timestamp>:<raw body>`. Key: `OPTIO_NEW_SLACK_SIGNING_SECRET`. Blank → `503`. Bad or stale (over 5 minutes) signature → `401`.
- Slash command `command=/optio` or an `app_mention` enqueues. `repo:<id>` in the text selects a catalog repo. Other commands are ignored. `url_verification` returns the challenge and does not enqueue.
- HTTP status for an accepted Slack command is `200` so the slash command can show `Queued.`

## Linear status change (team FIN)

`POST /webhooks/linear`

- Header `Linear-Signature`: hex HMAC-SHA256 of the raw body (no `sha256=` prefix). Key: `OPTIO_NEW_LINEAR_WEBHOOK_SECRET`. Blank → `503` `webhook_auth_unconfigured`. Bad signature, or `webhookTimestamp` older than 60 seconds, → `401` `invalid_signature`.
- Accepts `type: Issue`, `action: update`, when `updatedFrom` contains `stateId`, and the team key is `FIN` (`data.team.key`, or the identifier prefix `FIN-` when the team object is absent). Creates, comments, other teams, and edits that do not change status return `200` `{ "accepted": false, "reason": "ignored" }` and do not enqueue, so Linear does not retry them.
- `repoId` is `OPTIO_NEW_LINEAR_DEFAULT_REPO_ID` (kit-harness: `findjobabroad`). A blank value returns `503` `linear_repo_unconfigured`. An id missing from the catalog returns `400` `unknown_repo`. The workflow `repo_id` is not used for this route.
- Task id is `lin-<identifier>` (for example `lin-FIN-12`). Title and description come from the issue. The Linear URL is appended to the description when the payload has one.
- After the pipeline is enqueued, the orchestrator calls Linear GraphQL `commentCreate` with body exactly `queued`. The key is `OPTIO_NEW_LINEAR_API_KEY`. A missing key returns `503` `linear_api_unconfigured` and does not enqueue. Accepted responses are HTTP `200`.
- A retry whose BullMQ job id already exists still comments `queued` and returns `200`. One task id is one pipeline while that job id remains.
- API key policy: `commentCreate` is the live write. `issueUpdate` may set `stateId` only and is not called in this phase. `issueCreate`, `issueDelete`, and `issueArchive` are rejected. Scope stays team FIN. No Agent Sessions.

Linear's own webhook settings require a public HTTPS URL. The kit-harness edge in [caddy-tls-edge.md](caddy-tls-edge.md) is HTTP on the public IP until a domain exists. Point the Linear webhook at `https://<host>/webhooks/linear` once TLS is in front of `/webhooks/*`.

## Logs

Do not log the raw body, the signature header, or env values. `redactSecrets` strips `sha256=`, `v0=`, `ghp_`, `github_pat_`, `xox*`, `lin_api_`, and `sk-` substrings from the `500` error message. Startup logs repo ids and booleans (`githubToken: true`, `linearApiKey: true`), not token strings.

Caddy profile `edge` already proxies `/webhooks/*`. Loopback `POST /intake` stays unsigned on `127.0.0.1:3100`.
