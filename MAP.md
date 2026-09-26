# MAP — Optio-New tree → SPEC sections

Product: **Optio-New** · Compose: `optio-new` · Package: `@optio-new/harness`

| Path                                                  | SPEC section(s)   | Notes                                                                     |
| ----------------------------------------------------- | ----------------- | ------------------------------------------------------------------------- |
| `agents/{planner,implementation,review,ready,merge}/` | §2, §3, §4        | Eve slots: `agent.ts`, `instructions.md`, `tools/`, `skills/` refs        |
| `.cursor/agents/`                                     | §2, §5, §6.5      | In-repo specialist role stubs (SoT)                                       |
| `.cursor/skills/`                                     | §2, §6, §6.5      | In-repo skill bodies (SoT); `bot-session` replaces Linear `issue-session` |
| `specialists/{front-end,back-end,devops,database}/`   | §2, §5            | Eve subagent slots; prompt SoT remains `.cursor/agents`                   |
| `specialists/index.json`                              | §2, §5, §6.5      | Index → `.cursor/agents` (`slot_dir` names the mirror)                    |
| `docs/eve-patterns.md`                                | §2, §4, §14.0     | Eve-compatible filesystem vs Optio-owned BullMQ graph and worktrees       |
| `skills/index.json`                                   | §2, §6, §6.5      | Index → `.cursor/skills`                                                  |
| `workflows/default-task.yaml`                         | §3.1, §3.2        | Default New Bot–driven task step graph                                    |
| `orchestrator/intake/`                                | §8, §11           | New Bot chat/API intake → BullMQ enqueue (no Linear)                      |
| `orchestrator/jobs/`                                  | §11, §12, §14.0   | BullMQ stage graph; runnable TS in `src/orchestrator/jobs/`               |
| `state/migrations/001_pipeline_step_cursor.sql`       | §11, §14.0        | Postgres step cursor for crash resume                                     |
| `orchestrator/worktrees/`                             | §7, §6.5          | Notes; runnable manager is `src/orchestrator/worktrees/`                  |
| `orchestrator/sessions/`                              | §13.5             | Concurrency caps; workspace port plugs into worktrees                     |
| `src/orchestrator/sessions/`                          | §13.5             | Session gate, overflow, queue-depth telemetry                             |
| `orchestrator/jev/`                                   | §9, §14.3         | Decision client; Vercel AI Gateway base URL                               |
| `orchestrator/learning/`                              | §10               | Failure fingerprints → meta-tasks; TS in `src/orchestrator/learning/`     |
| `state/migrations/002_learnings.sql`                  | §10               | Postgres `learnings` (fingerprints, field tags, meta-issue drafts)        |
| `docs/learning-worker.md`                             | §10               | Queue `optio.learn`, env, kit-harness profile `learn`                     |
| `orchestrator/telemetry/`                             | §12.1–§12.4       | OTel helpers, canonical spans; code in `src/orchestrator/telemetry/`      |
| `docs/observability.md`                               | §12.2–§12.4       | v1 choice: Langfuse (not Phoenix); SigNoz export off by default           |
| `docs/ops/read-failed-run.md`                         | §12, §13.4        | How to read a failed stage: logs and `GET /tasks/:taskId/actions`         |
| `state/migrations/003_pipeline_stage_run.sql`         | §12, §13.4        | Per-stage timing, adapter usage, and agent actions                        |
| `orchestrator/routing/`                               | §14.4             | Hop-1 backend selection                                                   |
| `src/`                                                | §8, §11, §13, §14 | TypeScript harness (intake, jobs, adapters, gateway, gates)               |
| `src/agent/`                                          | §9, §13           | Request-response loop; tool calls pass hard gates before effects          |
| `src/harness/gates/`                                  | §9.1, §13         | Secrets deny, harness config lock, tool timeout; sidecar cannot override  |
| `src/kit-harness/permissions.ts`                      | §13.8             | Permission tiers for shell, git, and host actions                         |
| `docs/permission-tiers.md`                            | §13.8             | Tier matrix and stage defaults                                            |
| `tests/`                                              | —                 | Unit/smoke tests (`tsx --test`)                                           |
| `tests/eval/`                                         | —                 | Harness regression fixtures: intake → stages → mocked pull request        |
| `src/eval/`                                           | §11, §14.0        | Eval runner for the factory path                                          |
| `docs/ops/harness-eval.md`                            | —                 | How to run the harness eval in CI, nightly, or pre-release                |
| `AGENTS.md`                                           | —                 | Agent operating guide (New Bot, no Linear)                                |
| `src/adapters/cursor/`                                | §13, §14.1        | Cursor CLI headless (subscription only)                                   |
| `src/adapters/codex/`                                 | §13, §14.1–§14.2  | Codex CLI → LiteLLM, optional Caveman compat mount                        |
| `src/proxy/`                                          | §14.2             | Optional local Caveman proxy (default off; no Platform/Cloud)             |
| `docs/caveman-platform-eval.md`                       | §14.2             | Post-V1 eval: keep LiteLLM; do not default to Caveman Cloud               |
| `gateway/caveman/`                                    | §14.2             | `caveman.yaml.example` LiteLLM compat snippet                             |
| `src/adapters/coding-agent.ts`                        | §13.1             | Shared CodingAgent interface                                              |
| `gateway/litellm/`                                    | §14.2             | Example models gpt-4o, claude-sonnet, cache-exact                         |
| `gateway/jev-router/`                                 | §14.3–§14.4       | Plugins: jev, poorjev, laya, rules                                        |
| `deploy/laya/`                                        | §14.3             | Optional Compose profile `laya` CPU placeholder (`docs/laya.md`)          |
| `state/`                                              | §11, §10          | Postgres migrations / session state                                       |
| `docs/SPEC.md`                                        | (this document)   | Full skeleton specification                                               |
| `specs/agent-harness-skeleton-spec.md`                | —                 | Spec copy under specs/                                                    |
| `specs/harness-working-skills/`                       | §6 (staging)      | Historical skills snapshot                                                |
| `harness/staging/skills-from-git-collective/`         | §6 (staging)      | Historical skills snapshot (not SoT)                                      |
| `docker-compose.yml`                                  | §12.5–§12.6       | Redis, Postgres, orchestrator, LiteLLM, kit-harness, Laya, OTel, Caddy    |
| `deploy/README.md`                                    | §12.5             | Hetzner boot profiles, loopback ports, rollback, pull+rebuild             |
| `Dockerfile.kit-harness`                              | §12.5–§12.6       | Profile `harness`; decision sidecar on `127.0.0.1:3200`                   |
| `Dockerfile.orchestrator`                             | §12.6, §14.0      | Profile `full` and `orchestrator`; BullMQ worker health on :3100          |
| `scripts/vps-pull-rebuild.sh`                         | §12.5             | On-host `git pull` and Compose rebuild after merge                        |
| `Caddyfile`                                           | §12.5             | IP HTTP catch-all on `:80`; domain + TLS is a later swap                  |
| `docs/ops/caddy-tls-edge.md`                          | §12.5             | IP HTTP edge vs later domain + TLS; HMAC intake webhook                   |
| `deploy/systemd/*.service`                            | §12.5             | Compose on boot                                                           |
| `deploy/otel-collector-config.yaml`                   | §12.1             | Collector stub                                                            |
| `secrets/`                                            | §12.5, §14.5      | sops+age examples; runbook is `docs/secrets.md`                           |
| `scripts/secrets.sh`                                  | §12.5             | init, encrypt, check, compose, run, audit                                 |
| `docs/ops/postgres-storagebox-backup.md`              | §12.5             | Storage Box backup, retention, restore dry-run                            |
| `docs/ops/worktree-isolation.md`                      | §7, §6.5, §12.5   | Per-task git worktree on the CX33 disk; not a container per task          |
| `docs/ops/secret-redaction.md`                        | §12.1, §12.5      | Redact secrets in stage logs, spans, and agent dumps                      |
| `scripts/backup-postgres-to-storagebox.sh`            | §12.5             | pg_dump to restic, borg, sftp, or rsync                                   |
| `scripts/restore-postgres-storagebox-dry-run.sh`      | §12.5             | Restore drill; does not write to Postgres                                 |
| `deploy/systemd/optio-new-postgres-backup.timer`      | §12.5             | Daily backup; secrets via `scripts/secrets.sh run`                        |
| `deploy/cron/optio-new-postgres-backup`               | §12.5             | Cron alternative; do not enable together with the timer                   |
| `scripts/smoke-local.sh`                              | —                 | Local/CI smoke (compose up stays off)                                     |
| `scripts/smoke-compose-mac.sh`                        | §12.6             | Compose up/down of redis, postgres, litellm (Mac or Linux)                |
| `docs/mac-compose-smoke.md`                           | §12.6             | Mac runbook for issue #23                                                 |
| `.github/workflows/ci.yml`                            | —                 | Push + PR CI                                                              |
| `README.md`                                           | —                 | Points at `docs/SPEC.md`                                                  |
| `.gitignore`                                          | §12.5             | Excludes secrets / runtime                                                |
| `package.json`                                        | —                 | `@optio-new/harness`                                                      |

## Explicitly out of this skeleton

- Linear product integration (webhooks, GraphQL, Agent Sessions) — SPEC §8 ADR
- Second agent frameworks (CrewAI, Temporal, AutoGen, LangGraph-as-orchestrator) — §12.7
- Cursor RPC MITM — §14.1
- Caveman Cloud/Platform as a V1 dependency — `docs/caveman-platform-eval.md`
- Merging with or modifying `~/Projects/optio` or `kit-collective`
