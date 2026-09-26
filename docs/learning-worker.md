# Learning worker

SPEC §10. A BullMQ worker on `optio.learn` fingerprints review-gate and implementation failures, upserts them into Postgres, and opens a GitHub meta-issue when a configurable threshold is crossed.

The worker does **not** rewrite production gates, `workflows/*.yaml`, skill files, or always-on rules. A meta-issue is a proposal. A human applies any budget change.

## What it stores

Migration: `state/migrations/002_learnings.sql` (`learnings`).

Fingerprint = SHA-256 of workflow, step, sorted skill ids, sorted specialist ids, error class, and field tag. The same failure in another session increments the row. Excerpts are redacted (database URLs, bearer tokens, `sk-` / `ghp_` keys) before they are stored.

Default threshold is **3 hits inside 14 days**. `status` becomes `proposed` and `proposal_body` holds the meta-issue template (`meta/self-improve`), including the budget proposal and sample task ids.

## Queue

| Queue         | Producer                                           | Consumer          |
| ------------- | -------------------------------------------------- | ----------------- |
| `optio.learn` | stage runtime `learning` sink (review / implement) | `learning-worker` |

`processStageJob` records a failure when the review gate does not pass, and when the implement or review handler throws. A pass does not record. A learning-store error does not replace `ReviewGateClosedError`.

The planner step `invoke_planner` can read `listByField` and append those rows to the prompt. Proposed skill ids are deprioritized when another skill still matches. The hard allow-list is unchanged.

## Env

| Variable                  | Default | Meaning                                               |
| ------------------------- | ------- | ----------------------------------------------------- |
| `OPTIO_NEW_REDIS_URL`     |         | BullMQ connection. Required by the worker process.    |
| `OPTIO_NEW_DATABASE_URL`  |         | Postgres. The worker applies the learnings migration. |
| `OPTIO_LEARN_THRESHOLD`   | `3`     | Hits inside the window before a meta-issue is opened. |
| `OPTIO_LEARN_WINDOW_DAYS` | `14`    | Counting window.                                      |
| `OPTIO_LEARN_FILE_GITHUB` | `0`     | `1` files the draft via the GitHub API.               |
| `OPTIO_LEARN_GITHUB_REPO` |         | `owner/repo`, required when filing is on.             |
| `OPTIO_NEW_GITHUB_TOKEN`  |         | Token used only when filing is on.                    |

Filing is off unless `OPTIO_LEARN_FILE_GITHUB=1`, the token is set, and the repo is `owner/repo`. The draft is still stored when filing is off. Unit tests cover the GitHub request with a fake `fetch`. CI does not open a live issue.

If the `meta/self-improve` label is missing, the worker retries the create without labels. The body still says `meta/self-improve`.

## Enable on kit-harness

The service is Compose profile `learn`. It uses the same Redis and Postgres as the rest of the stack. It does not replace `kit-harness` (profile `harness`).

```bash
docker compose up -d redis postgres
docker compose --profile learn up -d --build learning-worker
docker compose logs learning-worker
```

The process logs `{ "service": "learning-worker", "event": "listen", "queue": "optio.learn" }`.

Check the table:

```bash
docker compose exec postgres psql -U optio -d optio_new \
  -c "select fingerprint, field_tag, hit_count, status, meta_issue_url from learnings;"
```

Host process (needs `OPTIO_NEW_REDIS_URL` and `OPTIO_NEW_DATABASE_URL`):

```bash
npm run learn-worker
```

Unit tests do not need Redis, Postgres, or a GitHub token:

```bash
npx vitest run tests/learning-worker.test.ts
```

## Follow-up

Applying an approved proposal to `workflows/*.yaml` is not done here. Jev’s self-learning threshold (SPEC §9.2) is not called; the counter is the bar.
