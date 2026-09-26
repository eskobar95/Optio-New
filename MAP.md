# MAP — Optio-New tree → SPEC sections

Product: **Optio-New** · Compose: `optio-new` · Package: `@optio-new/harness`

| Path                                                  | SPEC section(s)   | Notes                                                                     |
| ----------------------------------------------------- | ----------------- | ------------------------------------------------------------------------- |
| `agents/{planner,implementation,review,ready,merge}/` | §2, §3, §4        | Eve phase agents; `agent.ts` + `instructions.md` contracts                |
| `.cursor/agents/`                                     | §2, §5, §6.5      | In-repo specialist role stubs (SoT)                                       |
| `.cursor/skills/`                                     | §2, §6, §6.5      | In-repo skill bodies (SoT); `bot-session` replaces Linear `issue-session` |
| `specialists/index.json`                              | §2, §5, §6.5      | Index → `.cursor/agents`                                                  |
| `skills/index.json`                                   | §2, §6, §6.5      | Index → `.cursor/skills`                                                  |
| `workflows/default-task.yaml`                         | §3.1, §3.2        | Default New Bot–driven task step graph                                    |
| `orchestrator/intake/`                                | §8, §11           | New Bot chat/API intake → BullMQ enqueue (no Linear)                      |
| `orchestrator/jobs/`                                  | §11, §12, §14.0   | BullMQ stage graph; runnable TS in `src/orchestrator/jobs/`               |
| `state/migrations/001_pipeline_step_cursor.sql`       | §11, §14.0        | Postgres step cursor for crash resume                                     |
| `orchestrator/worktrees/`                             | §7, §6.5          | Worktree lifecycle keyed by task id                                       |
| `orchestrator/jev/`                                   | §9, §14.3         | Decision client; Vercel AI Gateway base URL                               |
| `orchestrator/learning/`                              | §10               | Failure fingerprints → meta-tasks                                         |
| `orchestrator/telemetry/`                             | §12.1–§12.4       | OTel helpers, canonical spans                                             |
| `orchestrator/routing/`                               | §14.4             | Hop-1 backend selection                                                   |
| `src/`                                                | §8, §11, §13, §14 | TypeScript harness (intake, jobs, adapters, gateway, gates)               |
| `src/agent/`                                          | §9, §13           | Request-response loop; tool calls pass hard gates before effects          |
| `src/harness/gates/`                                  | §9.1, §13         | Secrets deny, harness config lock, tool timeout; sidecar cannot override  |
| `tests/`                                              | —                 | Unit/smoke tests (`tsx --test`)                                           |
| `AGENTS.md`                                           | —                 | Agent operating guide (New Bot, no Linear)                                |
| `src/adapters/cursor/`                                | §13, §14.1        | Cursor CLI headless (subscription only)                                   |
| `src/adapters/codex/`                                 | §13, §14.1–§14.2  | Codex CLI → LiteLLM, optional Caveman compat mount                        |
| `src/proxy/`                                          | §14.2             | Optional local Caveman proxy (default off; no Platform/Cloud)             |
| `gateway/caveman/`                                    | §14.2             | `caveman.yaml.example` LiteLLM compat snippet                             |
| `src/adapters/coding-agent.ts`                        | §13.1             | Shared CodingAgent interface                                              |
| `gateway/litellm/`                                    | §14.2             | `config.yaml.example` model_list                                          |
| `gateway/jev-router/`                                 | §14.3–§14.4       | Plugins: jev, poorjev, laya, rules                                        |
| `state/`                                              | §11, §10          | Postgres migrations / session state                                       |
| `docs/SPEC.md`                                        | (this document)   | Full skeleton specification                                               |
| `specs/agent-harness-skeleton-spec.md`                | —                 | Spec copy under specs/                                                    |
| `specs/harness-working-skills/`                       | §6 (staging)      | Historical skills snapshot                                                |
| `harness/staging/skills-from-git-collective/`         | §6 (staging)      | Historical skills snapshot (not SoT)                                      |
| `docker-compose.yml`                                  | §12.5–§12.6       | Redis, Postgres, orchestrator/eve stubs, LiteLLM, Laya, OTel, Caddy       |
| `Caddyfile`                                           | §12.5             | Optional intake + GitHub webhook TLS                                      |
| `deploy/systemd/*.service`                            | §12.5             | Compose on boot                                                           |
| `deploy/otel-collector-config.yaml`                   | §12.1             | Collector stub                                                            |
| `secrets/`                                            | §12.5, §14.5      | sops+age examples; runbook is `docs/secrets.md`                           |
| `scripts/secrets.sh`                                  | §12.5             | init, encrypt, check, compose, audit                                      |
| `scripts/smoke-local.sh`                              | —                 | Local/CI smoke (compose up stays off)                                     |
| `scripts/smoke-compose-mac.sh`                        | §12.6             | Docker Desktop up/down of redis, postgres, litellm                        |
| `docs/mac-compose-smoke.md`                           | §12.6             | Mac runbook for issue #23                                                 |
| `.github/workflows/ci.yml`                            | —                 | Push + PR CI                                                              |
| `README.md`                                           | —                 | Points at `docs/SPEC.md`                                                  |
| `.gitignore`                                          | §12.5             | Excludes secrets / runtime                                                |
| `package.json`                                        | —                 | `@optio-new/harness`                                                      |

## Explicitly out of this skeleton

- Linear product integration (webhooks, GraphQL, Agent Sessions) — SPEC §8 ADR
- Second agent frameworks (CrewAI, Temporal, AutoGen, LangGraph-as-orchestrator) — §12.7
- Cursor RPC MITM — §14.1
- Merging with or modifying `~/Projects/optio` or `kit-collective`
