# Optio-New — status

Last refreshed: 2026-09-26 00:40 UTC

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

## Open issues

Open: 15.

Tracker: https://github.com/eskobar95/Optio-New/issues

- #23 [P2] Mac local verify: Docker Desktop compose up smoke (P2, documentation, good first issue, infra)
- #22 [P2] Caddy TLS edge for optional intake webhook (P2, deploy, infra, security)
- #21 [P2] Eve phase agents: planner / implementation / review / ready / merge contracts (P2, enhancement, orchestration)
- #20 [P1] Hetzner deploy: systemd + Compose beside LiteLLM/BullMQ (P1, deploy, infra)
- #19 [P2] Learning worker: failure fingerprints → meta GitHub issues (P2, enhancement, orchestration)
- #18 [P1] Postgres backups to Hetzner Storage Box (P1, deploy, infra, security)
- #16 [P2] Caveman Cloud/Platform evaluation (post-V1 only) (P2, cost-opt, documentation)
- #14 [P2] Optional Laya CPU decision service Compose profile (P2, harness, infra)
- #13 [P1] Observability: OTel spans + Langfuse/SigNoz wiring (P1, enhancement, infra)
- #12 [P1] Parallel agent sessions: concurrency caps + isolated worktrees (P1, enhancement, orchestration)
- #11 [P1] LiteLLM gateway + JevRouter plugins (jev / rules / laya) (P1, enhancement, harness, infra)
- #9 [P1] CodingAgent adapters: Cursor CLI + Codex → LiteLLM (P1, enhancement, orchestration)
- #6 [P0] Worktree manager: create / isolate / reap per task (P0, enhancement, orchestration, security)
- #5 [P0] Review gate: Jev/rules completion + CI green before ready (P0, enhancement, harness, orchestration)
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
