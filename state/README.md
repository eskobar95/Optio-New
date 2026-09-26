# state

Postgres schemas / migrations for sessions, budgets, fingerprints, step cursors, session artifacts, and adapter usage rows.

`003_pipeline_stage_run.sql` is the per-stage timing, usage, and agent-action table. `createPgStageRunStore` applies it on connect. `004_session_artifacts.sql` is the per-task plan, pull request link, stage outcome, and last error. `openOrchestratorDatabase` applies that DDL with the step cursor.

Place SQL or migration tooling under `migrations/`. Runtime DB only — not a second copy of skills/agents.
