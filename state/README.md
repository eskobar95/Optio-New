# state

Postgres schemas / migrations for sessions, budgets, fingerprints, step cursors, session artifacts, and adapter usage rows.

## Two migration tracks

| Track                 | Path                     | Role                                                                                                                                                                                                                         |
| --------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Legacy (frozen)**   | `state/migrations/*.sql` | Historical DDL applied on connect by `createPg*Store` / `openOrchestratorDatabase` for `public.*` runtime tables. **Do not renumber, rewrite, or delete.**                                                                   |
| **Forward (Drizzle)** | `drizzle/`               | Catalog schemas `optio` + `flue` (ENG-24 / ENG-35). Applied at orchestrator boot (`runDrizzleMigrations`) and via `npm run db:migrate`. Never edit applied migration files. See [docs/data-model.md](../docs/data-model.md). |

`003_pipeline_stage_run.sql` is the per-stage timing, usage, and agent-action table. `createPgStageRunStore` applies it on connect. `004_session_artifacts.sql` is the per-task plan, pull request link, stage outcome, and last error. `openOrchestratorDatabase` applies that DDL with the step cursor.

Runtime DB only — not a second copy of skills/agents. Catalog rows store **refs** (paths, Infisical env slugs), not secret plaintext.
