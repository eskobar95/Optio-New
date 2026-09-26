# Optio-New — status

Last refreshed: 2026-09-26 00:48 UTC

## Bootstrap progress

| Area                                                                     | Status                                                   |
| ------------------------------------------------------------------------ | -------------------------------------------------------- |
| In-repo `.cursor/skills` + `.cursor/agents` SoT                          | Done                                                     |
| Linear stripped → New Bot intake + BullMQ                                | Done                                                     |
| TypeScript `src/` + `tests/` + tooling (ESLint, Prettier, Vitest, Husky) | Done                                                     |
| Public GitHub + CI on push/PR                                            | Live                                                     |
| Good first issue: `src/agent/loop.ts`                                    | See open issues                                          |
| BullMQ stage graph (plan → merge) + Postgres step cursor                 | Skeleton (`docs/pipeline.md`)                            |
| Real model providers / GPU / Vercel key                                  | Pending (secrets local only)                             |
| kit-harness decision sidecar                                             | Compose profile `harness` (rules engine; Jev not called) |

## CI

[![CI](https://github.com/eskobar95/Optio-New/actions/workflows/ci.yml/badge.svg)](https://github.com/eskobar95/Optio-New/actions/workflows/ci.yml)

Latest conclusion: **success**

Actions: https://github.com/eskobar95/Optio-New/actions/workflows/ci.yml

## Compose smoke (Docker Desktop or Linux)

Issue [#23](https://github.com/eskobar95/Optio-New/issues/23). Runbook: [mac-compose-smoke.md](mac-compose-smoke.md). Command: `bash scripts/smoke-compose-mac.sh` (repo-root `.env`, or `.env.example` when `.env` is absent). Same path on Mac Docker Desktop and on Linux Docker, including kit-harness.

| Check                                                             | State                                                                                                      |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Compose config for redis, postgres, litellm                       | Scripted. CI runs `--config-only` when the Docker CLI is present, and always syntax-checks the script      |
| Isolated up/down (`optio-new-mac-smoke`, ports 16379/15432/14000) | Host-agnostic. kit-harness (Linux) full up/down PASSED 2026-09-26. GitHub Actions does not start the stack |
| Failure issues                                                    | None filed. Mac Docker Desktop remains optional                                                            |

Verified: kit-harness (Linux, Docker Compose) full `bash scripts/smoke-compose-mac.sh` PASSED on 2026-09-26 against `7aa4b2e` (redis PING, postgres pg_isready, litellm `/health/liveliness`, `down -v`). Project `optio-new` on 6379/5432/4000 stayed up. Config-only PASSED.

Gaps: LiteLLM tag `ghcr.io/berriai/litellm:main-latest` floats; profile `full` (orchestrator, eve-runner) stays out of this smoke; provider keys stay empty; the check is `/health/liveliness`, which does not call a model.

## Open issues

Open: 12.

Tracker: https://github.com/eskobar95/Optio-New/issues

- #45 [e2e] Add a hello-world endpoint to the agent loop (P2, enhancement, good first issue, orchestration)
- #22 [P2] Caddy TLS edge for optional intake webhook (P2, deploy, infra, security)
- #21 [P2] Eve phase agents: planner / implementation / review / ready / merge contracts (P2, enhancement, orchestration)
- #20 [P1] Hetzner deploy: systemd + Compose beside LiteLLM/BullMQ (P1, deploy, infra)
- #19 [P2] Learning worker: failure fingerprints → meta GitHub issues (P2, enhancement, orchestration)
- #18 [P1] Postgres backups to Hetzner Storage Box (P1, deploy, infra, security)
- #16 [P2] Caveman Cloud/Platform evaluation (post-V1 only) (P2, cost-opt, documentation)
- #14 [P2] Optional Laya CPU decision service Compose profile (P2, harness, infra)
- #13 [P1] Observability: OTel spans + Langfuse/SigNoz wiring (P1, enhancement, infra)
- #11 [P1] LiteLLM gateway + JevRouter plugins (jev / rules / laya) (P1, enhancement, harness, infra)
- #6 [P0] Worktree manager: create / isolate / reap per task (P0, enhancement, orchestration, security)
- #4 [P1] Docker Compose full stack: redis, postgres, orchestrator, litellm, kit-harness (P1, enhancement, infra)

## Refresh

Manual refresh (GitHub CLI authenticated via `gh auth login`):

```bash
npm run status
```

The script is idempotent: this file is rewritten only when the latest CI conclusion or the open-issue list changes.

Automation: `.github/workflows/status.yml` runs the same script on a daily schedule, on `workflow_dispatch`, and after the CI workflow completes on `main`.

## Structure overview

```text
Optio-New/
  src/           # TypeScript harness (intake, jobs, adapters, gateway, kit-harness)
  tests/         # Vitest
  agents/        # Eve phase contracts
  .cursor/       # Skills + specialist agents (SoT)
  docs/          # SPEC.md, status.md
  workflows/     # default-task.yaml
  orchestrator/  # Domain READMEs (intake, jobs, …)
  docker-compose.yml
```

Decision layer: **New Bot**. Pipeline: **BullMQ**. Linear: **out** (SPEC §8).
