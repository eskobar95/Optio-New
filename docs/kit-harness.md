# kit-harness

Control and decision sidecar for Optio-New. It answers five deterministic questions the pipeline asks before and after a coding step. **New Bot** stays the intake and the human gate. **BullMQ** stays the job graph. kit-harness does not enqueue work, open PRs, or call Linear.

The shape follows Kit Collective’s factory box: a small decision service beside the workers. It is not a copy of a Linear planner. Jev remains the soft advisor in the spec (SPEC §9, §14.4). This build ships the **rules plugin** only. `JEV_BASE_URL` is recorded on `/health` and is not called.

## Branch

Work lives on **`harness/staging`**. The pull request into `main` stays a draft until the Hetzner checklist below is done. Do not merge from this branch as part of local testing.

## What it decides

| Module           | Call                           | Result                                             |
| ---------------- | ------------------------------ | -------------------------------------------------- |
| model-routing    | Hop 1, given step context      | `cursor_subscription` \| `codex_gateway` \| `deny` |
| tool-gate        | `decideTool(tool, context)`    | `allow` \| `confirm` \| `deny`                     |
| completion-check | `checkCompletion(evidence)`    | `pass` \| `fail` \| `retry`                        |
| loop-detect      | failure window from the caller | `loop_detected` plus `stop` or `replan`            |
| split-or-proceed | size and signals               | `proceed` \| `split` with subtasks                 |

Hard rules win. A closed quota, an empty budget, a secret path, a destructive command, an allow-list miss, and open blockers never flip because an advisor said otherwise. Missing Hop 1 evidence fails closed (`deny` / `undecided`).

Hop 1 default when **both** quotas are open: `cursor_subscription` (`rules_default_cursor`). A step `coding_backend` of `cursor` or `codex` overrides that. There is no Cursor RPC proxy here (SPEC §14.1).

## HTTP

Compose publishes **`127.0.0.1:3200`** (override the host port with `KIT_HARNESS_PORT`). Inside the Compose network the service name is `kit-harness`.

| Method | Path                   |
| ------ | ---------------------- |
| `GET`  | `/health`              |
| `GET`  | `/v1/audit`            |
| `POST` | `/v1/route-model`      |
| `POST` | `/v1/tool-gate`        |
| `POST` | `/v1/completion-check` |
| `POST` | `/v1/loop-detect`      |
| `POST` | `/v1/split-or-proceed` |

`/health` returns `engine: "rules"` and `jev_configured`. `jev_configured: true` means the variable is set. It does not mean a request was sent.

Bodies are JSON, at most 64 KiB. Unknown fields are rejected.

```bash
curl -s http://127.0.0.1:3200/health

curl -s http://127.0.0.1:3200/v1/route-model \
  -H 'content-type: application/json' \
  -d '{"coding_backend":"codex","codex_quota_remaining":4}'

curl -s http://127.0.0.1:3200/v1/tool-gate \
  -H 'content-type: application/json' \
  -d '{"tool":"shell","context":{"command":"rm -rf /tmp/optio-agent","agent_id":"scenario-agent"}}'

curl -s http://127.0.0.1:3200/v1/audit

curl -s http://127.0.0.1:3200/v1/completion-check \
  -H 'content-type: application/json' \
  -d '{"tests_green":true,"typecheck_green":true,"lint_green":true}'

curl -s http://127.0.0.1:3200/v1/loop-detect \
  -H 'content-type: application/json' \
  -d '{"events":[{"fingerprint":"abc","tool":"run_tests","outcome":"fail"},{"fingerprint":"abc","tool":"run_tests","outcome":"fail"},{"fingerprint":"abc","tool":"run_tests","outcome":"fail"}]}'

curl -s http://127.0.0.1:3200/v1/split-or-proceed \
  -H 'content-type: application/json' \
  -d '{"title":"wide change","estimated_files":12}'
```

Loop detection is stateless. The caller sends the recent window (max 200 events). Three identical failure fingerprints suggest `replan`; five suggest `stop`. Three consecutive failures of the same tool suggest `stop`.

Split defaults: more than 8 files, more than 5 steps, a known signal (`multi_package`, `schema_and_ui`, `cross_cutting`), or a description with at least three bullet or numbered lines.

## Local test

Unit and HTTP tests (no Docker):

```bash
npm install
npm test
npm run ci
```

Process on the host, no image:

```bash
npm run kit-harness
curl -s http://127.0.0.1:3200/health
```

Compose (profile `harness` — a plain `docker compose up` does not start it):

```bash
docker compose --profile harness up -d --build kit-harness
curl -s http://127.0.0.1:3200/health
docker compose --profile harness stop kit-harness
```

`npm run smoke` (also the last step of `npm run ci`) compiles the sidecar, starts it on `127.0.0.1:3217`, and checks health plus Hop-1 routing. It then runs eight scenarios:

1. Forbidden tool: `shell` + `rm -rf` returns `deny`, is stored on `GET /v1/audit`, and emits `event: "tool_denied"`.
2. Infinite loop: three `shell` failures with different fingerprints return `loop_detected`, `suggestion: "stop"`, and `halt: true`.
3. Tool allowance: a run with `max_tool_calls: 2` allows two `read_file` calls and denies the third with `tool_allowance_exceeded`.
4. Secret read: `read_file` of `.env` returns `deny` with `hard_deny_secret` and is logged.
5. Self-config: `edit_file` of `AGENTS.md` returns `deny` with `self_config_mutation`.
6. Hung tool: a runner that never returns is cancelled with `tool_timeout` (smoke waits 40ms).
7. End-to-end stub: intake → worktree → implementation → review → PR, with no Cursor or Codex process.
8. Worktree isolation: one agent cannot write the other agent's tree through `..` or an absolute path.

When Docker is present, smoke also checks that `kit-harness` is absent from the default project and present with `--profile harness`.

```bash
npm run smoke
```

## Hello-world: intake → plan

kit-harness does not enqueue pipeline jobs. The orchestrator does. On the kit-harness host, profile `full` starts that process on `127.0.0.1:3100`. The eve-runner container in the same profile is still a stub. This check does not open another port.

```bash
docker compose --profile full --profile harness up -d --build orchestrator
HELLO_WORLD_E2E=1 bash scripts/hello-world-e2e.sh
```

The script requires `GET /health`, then checks `GET /hello`, posts `POST /intake`, and polls `GET /hello/plan` until `progressed` is true and the plan cursor is `completed`. `npm run smoke` runs the same script and skips when nothing is listening. `HELLO_WORLD_E2E=1` turns that skip into a failure. The script talks to the orchestrator on `:3100`. kit-harness on `:3200` stays a sidecar.

## Beside LiteLLM and BullMQ on Hetzner

On the VPS the practical stack is already Redis, Postgres, the BullMQ orchestrator, and LiteLLM (SPEC §12.6, §14.2). kit-harness sits in the same Compose project and does not replace either neighbor.

```text
New Bot (intake, human gates)
    │ enqueue
    ▼
BullMQ workers ──HTTP──► kit-harness:3200   (this service, profile harness)
    │                         │
    │ run CodingAgent         │ rules now; Jev advisor later
    ▼                         ▼
Cursor CLI (subscription, no MITM)
    or
Codex CLI ──► LiteLLM :4000 ──► provider / cache
```

Workers are not clients of the sidecar yet. Until they are, BullMQ and LiteLLM behave as they do on `main`. Codex still uses LiteLLM for Hop 2 (`gateway/jev-router/`). kit-harness only answers Hop 1 and the gate questions above.

The learning worker is a separate Compose profile (`learn`), not part of this sidecar. It fingerprints failures into Postgres and can open GitHub meta-issues. See [learning-worker.md](learning-worker.md). `docker compose --profile learn up -d --build learning-worker` after redis and postgres are up.

Keep port 3200 on loopback and on the Compose network. Do not put it behind Caddy.

## Still needed for a Hetzner deploy

Do not point the server at this branch and expect a finished production rollout. After the draft PR merges, the box still needs:

1. **Profile enablement.** `deploy/systemd/optio-new-compose.service` sets `COMPOSE_PROFILES=harness,orchestrator` and calls `scripts/secrets.sh compose up -d` from `/opt/optio-new`. That starts kit-harness and the BullMQ orchestrator beside the default set (redis, postgres, litellm). LiteLLM stays unprofiled so the Mac compose smoke still sees it. Profile `full` still adds eve-runner for `docker compose --profile full --profile harness up -d`. Profile `edge` stays off. See `deploy/README.md`.
2. **Image on the box.** Nothing is pushed to a registry. After merge, `bash scripts/vps-pull-rebuild.sh` on the VPS runs `compose up -d --build`, which builds `Dockerfile.kit-harness` and `Dockerfile.orchestrator`. The runtime image installs this repo’s production `dependencies` (including BullMQ’s client libraries) even though the process does not open Redis.
3. **Secrets.** The rules engine needs none. When an advisor is actually connected, set `JEV_BASE_URL` and any gateway key in the host env and encrypt with sops+age (`docs/secrets.md`). The unit does not use `EnvironmentFile`. Do not bake keys into the image. v0 will still ignore the URL except for the health flag.
4. **Jev client.** No HTTP client, timeout, auth header, or shadow mode. `DecisionAdvisor` is an in-process hook used by tests. Wiring it to Vercel AI Gateway (or a later TypeSafe / Laya base URL) is separate work, and it must not be able to override a hard deny (SPEC §9.1).
5. **Worker calls.** BullMQ handlers do not call `/v1/*` yet. Deploying the container alone does not change routing, tool gates, or completion.
6. **Firewall and DNS.** Publish stays `127.0.0.1`. Orchestrator containers should use `http://kit-harness:3200`. Do not open 3200 on the Hetzner Cloud Firewall. No public name.
7. **Health versus restart.** The Compose healthcheck calls `GET /health`. `restart: unless-stopped` restarts the process when it exits. It does not restart a container that stays up and turns unhealthy. Add a watchdog later if unhealthy must recycle the process. Nothing scrapes the check into SigNoz yet.
8. **Limits.** The service sets `deploy.resources.limits` to 0.50 CPU and 256M as a starting cap, not a measurement from the Hetzner plan. Adjust after looking at RSS. Compose applies these limits on `up`; Swarm is not required.
9. **Spans and state.** SPEC §12.4 `jev.decision` spans are not emitted. Loop state is not stored; the worker must send the fingerprint window (SPEC §10.1).

## Layout

```text
src/kit-harness/          rules + HTTP server
Dockerfile.kit-harness    multi-stage Node 22 image
docker-compose.yml        service kit-harness, profile harness
tests/kit-harness/        Vitest, including a mock advisor
```
