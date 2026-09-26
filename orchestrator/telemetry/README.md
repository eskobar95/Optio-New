# orchestrator/telemetry

OpenTelemetry spans for the BullMQ stage graph. Runnable code: `src/orchestrator/telemetry/`.

Every span carries `task_id` and `worktree_id` (empty string when no worktree exists yet).

Canonical names (SPEC §12.4): `workflow.step`, `agent.run`, `specialist.call`, `skill.load`, `jev.decision`, `worktree.create`, `worktree.remove`, `intake.webhook`, `gate.pass`, `gate.fail`, `session.queue`.

`session.queue` is emitted by `SessionTelemetry` in `src/orchestrator/sessions` when a coding-session slot is granted, queued, rejected, released, or cancelled. Attribute `queue_depth` matches gauge `session.queue_depth` (labeled by `provider`, plus `active` and `cap`). The session gate runs without an exporter; `InMemorySessionTelemetry` is the test recorder.

Langfuse and SigNoz exporters are off unless `OPTIO_OTEL_LANGFUSE` or `OPTIO_OTEL_SIGNOZ` is `true`. v1 agent UI is Langfuse; Phoenix is not wired. See `docs/observability.md`.
