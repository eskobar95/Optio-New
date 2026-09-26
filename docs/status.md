# Optio-New — status

Last refreshed: 2026-09-26 01:00 WEST

## Bootstrap progress

| Area                                                                     | Status                       |
| ------------------------------------------------------------------------ | ---------------------------- |
| In-repo `.cursor/skills` + `.cursor/agents` SoT                          | Done                         |
| Linear stripped → New Bot intake + BullMQ                                | Done                         |
| TypeScript `src/` + `tests/` + tooling (ESLint, Prettier, Vitest, Husky) | Done                         |
| Public GitHub + CI on push/PR                                            | Live                         |
| Good first issue: `src/agent/loop.ts`                                    | See open issues              |
| Full BullMQ hello-world workers                                          | Pending                      |
| Real model providers / GPU / Vercel key                                  | Pending (secrets local only) |

## CI

[![CI](https://github.com/eskobar95/Optio-New/actions/workflows/ci.yml/badge.svg)](https://github.com/eskobar95/Optio-New/actions/workflows/ci.yml)

Latest conclusion: **success**

Actions: https://github.com/eskobar95/Optio-New/actions/workflows/ci.yml

## Open issues

- #1 good first issue: request-response agent loop (src/agent/loop.ts) (enhancement, good first issue, orchestration)

## Structure overview

```text
Optio-New/
  src/           # TypeScript harness (intake, jobs, adapters, gateway)
  tests/         # Vitest
  agents/        # Eve phase contracts
  .cursor/       # Skills + specialist agents (SoT)
  docs/          # SPEC.md, status.md
  workflows/     # default-task.yaml
  orchestrator/  # Domain READMEs (intake, jobs, …)
  docker-compose.yml
```

Decision layer: **New Bot**. Pipeline: **BullMQ**. Linear: **out** (SPEC §8).
