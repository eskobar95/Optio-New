# Observability (SPEC §12)

v1 uses one OpenTelemetry path. Spans are always recorded in-process. Export is off until an env flag is the string `true`.

## Langfuse, not Phoenix, for the agent UI

**Langfuse** (MIT, self-hosted) is the v1 agent UI. Sessions are keyed by `task_id`. Phoenix (Arize, ELv2) stays the fallback if Langfuse’s ClickHouse + Postgres + Redis stack is too heavy for a small VPS. Phoenix is not wired. SPEC §12.6 says not to run two agent UIs in v1.

**SigNoz** (MIT) is the infra OTLP sink for orchestrator traces, logs, and metrics. It is also off by default. Do not send the agent deep-dive to both Langfuse and SigNoz as two competing UIs; SigNoz receives the same OTLP spans when its flag is on so queue and host traces have a home.

## Flags

| Variable                                      | Default                           | Effect                                                |
| --------------------------------------------- | --------------------------------- | ----------------------------------------------------- |
| `OPTIO_OTEL_LANGFUSE`                         | `false`                           | `true` exports OTLP to Langfuse                       |
| `OPTIO_OTEL_SIGNOZ`                           | `false`                           | `true` exports OTLP to SigNoz or the collector        |
| `LANGFUSE_HOST`                               | `http://127.0.0.1:3000`           | Host used to build `/api/public/otel/v1/traces`       |
| `OPTIO_LANGFUSE_OTLP_ENDPOINT`                | empty                             | Full traces URL; overrides `LANGFUSE_HOST`            |
| `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` | empty                             | Basic auth on the Langfuse exporter when both are set |
| `OPTIO_SIGNOZ_OTLP_ENDPOINT`                  | `http://127.0.0.1:4318/v1/traces` | Collector or SigNoz OTLP/HTTP traces URL              |

## Spans

`processStageJob` emits `workflow.step` for plan → implement → review → ready → merge. Each span has `task_id` and `worktree_id` (`""` until a worktree exists). `agent.run` and `skill.load` nest under the stage. `enqueueIntakePipeline` emits `intake.webhook`. Kit-harness tool gates emit `gate.pass` or `gate.fail`. Cursor and Codex `run` emit `agent.run` around the CLI call; a non-succeeded status fails the span and still returns the adapter result. When the CLI JSON includes usage, that span also carries `provider`, `model_id`, `input_tokens`, `output_tokens`, `cached_tokens`, and `cost_usd`. Span attributes, status messages, and exception events are redacted before export. See [docs/ops/secret-redaction.md](ops/secret-redaction.md).

Stage start/end, failure reason, token or cost rows, and per-step agent actions are stored on `pipeline_stage_run` and returned by `GET /tasks/:taskId/actions`. Failure reasons and action text are redacted before they are stored. How to read a failed run: `docs/ops/read-failed-run.md`.

`session.queue` stays on `SessionTelemetry` (`src/orchestrator/sessions`). The session gate does not require an exporter.

`invokeSpecialist` emits `specialist.call`. `WorktreeManager` emits `worktree.create` when a checkout is first added and `worktree.remove` when that directory is deleted. Both spans carry `task_id` and `worktree_id`. Returning an existing checkout does not emit a second create. `reap({ merged: false })` while `retainOnFailure` is true does not emit remove. `jev.decision` is emitted by the ENG-27 Jev MCP soft tools (`createOtelJevMcpTelemetry`). See `docs/ops/worktree-isolation.md`.

The collector stub is `deploy/otel-collector-config.yaml` (Compose profile `observability`, loopback `4317`/`4318`, debug exporter).

Regenerate the sample trace with `npx tsx scripts/emit-local-trace.ts`, then `npm run status`.
