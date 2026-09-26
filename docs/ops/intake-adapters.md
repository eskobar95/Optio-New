# GitHub and Slack intake

Adapters normalize into `bot.intake.created` and call `enqueueIntakePipeline`. There is no Linear adapter. SPEC §8 ADR: Linear webhooks, GraphQL, and Agent Sessions stay out of Optio-New v1. `POST /webhooks/linear` returns `404` `linear_deferred` and does not enqueue.

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

## Logs

Do not log the raw body, the signature header, or env values. `redactSecrets` strips `sha256=`, `v0=`, `ghp_`, `github_pat_`, `xox*`, and `sk-` substrings from the `500` error message. Startup logs repo ids and booleans (`githubToken: true`), not token strings.

Caddy profile `edge` already proxies `/webhooks/*`. Loopback `POST /intake` stays unsigned on `127.0.0.1:3100`.
