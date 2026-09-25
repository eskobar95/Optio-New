# Optio-New — status

Last refreshed: _run `bash scripts/update-status.sh`_

## Bootstrap progress

| Area                                                                     | Status                              |
| ------------------------------------------------------------------------ | ----------------------------------- |
| In-repo `.cursor/skills` + `.cursor/agents` SoT                          | Done                                |
| Linear stripped → New Bot intake + BullMQ                                | Done                                |
| TypeScript `src/` + `tests/` + tooling (ESLint, Prettier, Vitest, Husky) | Done                                |
| Public GitHub + CI on push/PR                                            | In progress / live after first push |
| Good first issue: `src/agent/loop.ts`                                    | Open after first push               |
| Full BullMQ hello-world workers                                          | Pending                             |
| Real model providers / GPU / Vercel key                                  | Pending (secrets local only)        |

## CI

[![CI](https://github.com/eskobar95/Optio-New/actions/workflows/ci.yml/badge.svg)](https://github.com/eskobar95/Optio-New/actions/workflows/ci.yml)

Latest conclusion: _unknown — refresh with script_

## Open issues

_Refresh with `bash scripts/update-status.sh` (requires `gh`)._

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
