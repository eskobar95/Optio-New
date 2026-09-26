# orchestrator/telemetry

OpenTelemetry helpers and canonical span names (`workflow.step`, `agent.run`, `specialist.call`, `skill.load`, `jev.decision`, `worktree.create|remove`, `intake.webhook`, `gate.pass|fail`, `session.queue`). Every span carries `task_id` and `worktree_id`.

`session.queue` is emitted when a coding-session slot is granted, queued, rejected, released, or cancelled. Attribute `queue_depth` matches gauge `session.queue_depth` (labeled by `provider`, plus `active` and `cap`). `worktree_id` is empty until the workspace is claimed. The v1 recorder is `SessionTelemetry` in `src/orchestrator/sessions`; an OTel exporter implements that interface. No SDK is required to run the gate.
