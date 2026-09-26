# state

Postgres schemas / migrations for sessions, budgets, fingerprints, step cursors, and adapter usage rows.

`003_pipeline_stage_run.sql` is the per-stage timing, usage, and agent-action table. `createPgStageRunStore` applies it on connect.

Place SQL or migration tooling under `migrations/`. Runtime DB only — not a second copy of skills/agents.
