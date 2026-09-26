# Optio-New — status

Last refreshed: 2026-09-26 12:34 UTC

## Bootstrap progress

| Area                                                                     | Status                                                        |
| ------------------------------------------------------------------------ | ------------------------------------------------------------- |
| In-repo `.cursor/skills` + `.cursor/agents` SoT                          | Done                                                          |
| Linear stripped → New Bot intake + BullMQ                                | Done                                                          |
| TypeScript `src/` + `tests/` + tooling (ESLint, Prettier, Vitest, Husky) | Done                                                          |
| Public GitHub + CI on push/PR                                            | Live                                                          |
| Good first issue: `src/agent/loop.ts`                                    | See open issues                                               |
| BullMQ stage graph (plan → merge) + Postgres step cursor                 | Orchestrator image: `POST /intake` and `GET /health` on :3100 |
| Real model providers / GPU / Vercel key                                  | Pending (secrets local only)                                  |
| kit-harness decision sidecar                                             | Compose profile `harness` (rules engine; Jev not called)      |

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

Orchestrator verify (profiles `full` and `harness`; orchestrator `127.0.0.1:3100`, kit-harness `127.0.0.1:3200`, eve-runner `127.0.0.1:3210`):

```bash
docker compose --profile full --profile harness up -d --build orchestrator
HELLO_WORLD_E2E=1 bash scripts/hello-world-e2e.sh
```

`GET /hello` is the demo card. The script posts intake and polls `GET /hello/plan` until the plan cursor is `completed`. `GET /health` is 200 when Redis answers. Without a listener the script skips; `HELLO_WORLD_E2E=1` fails closed.

Host health after [#76](https://github.com/eskobar95/Optio-New/pull/76): Compose profiles `harness`, `full`, and `learn`. `GET /health` confirmed on :3100 (orchestrator), :3200 (kit-harness), and :3210 (eve-runner). Hello-world e2e PASS (`POST /intake` → plan `completed`). No open issues after #77 closed. Overnight summary: [STATUS.md](../STATUS.md).

## Open issues

Open: 11.

Tracker: https://github.com/eskobar95/Optio-New/issues

- #95 CX33 disk and memory guardrails before worktree create (P2, backlog, enhancement, infra)
- #94 GitHub and Slack intake adapters (Linear deferred) (P2, backlog, enhancement, orchestration)
- #93 Multi-repo support for worktrees and intake routing (P2, backlog, enhancement, infra, orchestration)
- #92 Session artifact trail for plans, reviews, and PR links (P1, backlog, enhancement, orchestration)
- #91 Crash recovery and resume mid-pipeline (P1, backlog, enhancement, infra, orchestration)
- #90 Permission tiers for agent shell, git, and host actions (P1, backlog, enhancement, orchestration, security)
- #88 Secrets redaction in logs, traces, and agent dumps (P1, backlog, enhancement, security)
- #87 Cost and token budget caps per task (P1, backlog, enhancement, orchestration)
- #86 Human-in-the-loop approval stage for plan and merge (P1, backlog, enhancement, orchestration)
- #82 Observability: per-stage timing, tokens, and agent action inspection (P1, backlog, enhancement, orchestration)
- #81 Review-gate: tests, lint, and security/diff review before PR merge (P1, enhancement, orchestration, security)

## Refresh

Manual refresh (GitHub CLI authenticated via `gh auth login`):

```bash
npm run status
```

The script is idempotent: this file is rewritten only when the latest CI conclusion or the open-issue list changes.

Automation: `.github/workflows/status.yml` runs the same script on a daily schedule, on `workflow_dispatch`, and after the CI workflow completes on `main`.

## Observability

v1 agent UI is Langfuse; Phoenix is not wired. SigNoz is the infra OTLP sink. Both exporters default off. Decision: `docs/observability.md`.

Local pipeline trace (in-process OTel, exporters off):

```json
{
  "exporters": [],
  "intake": {
    "name": "intake.webhook",
    "task_id": "t-local",
    "worktree_id": "",
    "session_id": "s-local",
    "status": "ok",
    "traceId": "148a857035e3b0c0df81bdfd75d77d3f",
    "spanId": "edd3e0f74117fbc8"
  },
  "stages": [
    {
      "step_id": "plan",
      "task_id": "t-local",
      "worktree_id": "",
      "status": "ok",
      "traceId": "41f6fea246a153f9789ba0ffcda19de7",
      "spanId": "eb011a82fb883aca"
    },
    {
      "step_id": "implement",
      "task_id": "t-local",
      "worktree_id": "",
      "status": "ok",
      "traceId": "be4b64111fbf0f0fd2c7fce6eeb5ec47",
      "spanId": "90e8864b2610fef6"
    },
    {
      "step_id": "review",
      "task_id": "t-local",
      "worktree_id": "",
      "status": "ok",
      "traceId": "fb53987aa6c74292d7166d157988da10",
      "spanId": "d2b065dd14d26251"
    },
    {
      "step_id": "ready",
      "task_id": "t-local",
      "worktree_id": "",
      "status": "ok",
      "traceId": "c7d46763effb378a47c8b0df618a9393",
      "spanId": "9b7bfa6bed3db01f"
    },
    {
      "step_id": "merge",
      "task_id": "t-local",
      "worktree_id": "",
      "status": "ok",
      "traceId": "aa3cccfa86f1e41924b1ea10980e3c74",
      "spanId": "f760cba22062af6d"
    }
  ],
  "planTrace": [
    {
      "name": "skill.load",
      "traceId": "28eb83579bfd2402651df3ace69e3e30",
      "spanId": "15c9a81cfba9a5cf",
      "parentSpanId": "1211092309eb6bfa",
      "status": "ok",
      "attributes": {
        "task_id": "t-local",
        "worktree_id": "",
        "skill_id": "bot-session",
        "step_id": "ack_session"
      }
    },
    {
      "name": "agent.run",
      "traceId": "28eb83579bfd2402651df3ace69e3e30",
      "spanId": "1211092309eb6bfa",
      "parentSpanId": "311a3f1bb24fbe36",
      "status": "ok",
      "attributes": {
        "task_id": "t-local",
        "worktree_id": "",
        "workflow_id": "default-task",
        "step_id": "ack_session",
        "agent_id": "agents/plan",
        "session_id": "s-local"
      }
    },
    {
      "name": "skill.load",
      "traceId": "28eb83579bfd2402651df3ace69e3e30",
      "spanId": "3d0ef97c7e5c0c56",
      "parentSpanId": "eb3c160a682310f1",
      "status": "ok",
      "attributes": {
        "task_id": "t-local",
        "worktree_id": "",
        "skill_id": "bot-session",
        "step_id": "invoke_planner"
      }
    },
    {
      "name": "agent.run",
      "traceId": "28eb83579bfd2402651df3ace69e3e30",
      "spanId": "eb3c160a682310f1",
      "parentSpanId": "311a3f1bb24fbe36",
      "status": "ok",
      "attributes": {
        "task_id": "t-local",
        "worktree_id": "",
        "workflow_id": "default-task",
        "step_id": "invoke_planner",
        "agent_id": "agents/plan",
        "session_id": "s-local"
      }
    },
    {
      "name": "workflow.step",
      "traceId": "28eb83579bfd2402651df3ace69e3e30",
      "spanId": "311a3f1bb24fbe36",
      "parentSpanId": null,
      "status": "ok",
      "attributes": {
        "task_id": "t-local",
        "worktree_id": "",
        "workflow_id": "default-task",
        "step_id": "plan",
        "session_id": "s-local"
      }
    }
  ]
}
```

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

## Decisions

Caveman Cloud/Platform stays off for V1. Codex stays on local LiteLLM. Eval: [caveman-platform-eval.md](caveman-platform-eval.md) (issue #16).
