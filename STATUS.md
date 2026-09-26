# Overnight lander — STATUS

Recorded: 2026-09-26 02:00 UTC. Base: `main` at `1e932b9`, which includes [#76](https://github.com/eskobar95/Optio-New/pull/76).

Project board snapshot: [docs/status.md](docs/status.md).

## Kit-harness deploy tip and health

`main` tip (includes #76): `1e932b976e1de9bb49ef6d11fa1f8c13ac7bf703`

```text
1e932b9 docs: refresh status snapshot
09e1b19 fix: publish eve-runner on 127.0.0.1:3210 (#76)
```

#76 merged 2026-09-26 01:48:02Z and publishes eve-runner on `127.0.0.1:3210` (`EVE_RUNNER_PORT`, Compose publish, healthcheck). kit-harness stays on `127.0.0.1:3200`. Orchestrator stays on `127.0.0.1:3100`.

Host checkout `/opt/optio-new` after that merge. Compose profiles `harness`, `full`, and `learn`. Health confirmed on the host:

| Service      | Profile   | Bind             | Check         |
| ------------ | --------- | ---------------- | ------------- |
| orchestrator | `full`    | `127.0.0.1:3100` | `GET /health` |
| kit-harness  | `harness` | `127.0.0.1:3200` | `GET /health` |
| eve-runner   | `full`    | `127.0.0.1:3210` | `GET /health` |

Profile `learn` starts `learning-worker` (queue `optio.learn`) beside that set. #76 closed [#77](https://github.com/eskobar95/Optio-New/issues/77).

Checked-in boot unit `deploy/systemd/optio-new-compose.service` sets `COMPOSE_PROFILES=harness,orchestrator`. `scripts/vps-pull-rebuild.sh` reads that unit.

## What landed overnight

Eve [#58](https://github.com/eskobar95/Optio-New/issues/58)–[#62](https://github.com/eskobar95/Optio-New/issues/62), then the follow-on fixes. Times are commit time on 2026-09-26 UTC.

| Issue                       | PR                                                    | Merge               | What                                                                         |
| --------------------------- | ----------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------- |
| #58 EVE-1 phase-agent slots | [#63](https://github.com/eskobar95/Optio-New/pull/63) | `4b251d2` 01:14:33Z | Eve slots for phase agents and specialists                                   |
| #59 EVE-2 SkillLoader       | [#67](https://github.com/eskobar95/Optio-New/pull/67) | `3fb8418` 01:16:52Z | Allow-list, worktree seed/reap, `load_skill` hard deny                       |
| #60 EVE-3 eve-runner        | [#66](https://github.com/eskobar95/Optio-New/pull/66) | `108818f` 01:30:55Z | Local eve-runner for one BullMQ stage step                                   |
| #61 EVE-4 specialists       | [#64](https://github.com/eskobar95/Optio-New/pull/64) | `f9d9143` 01:14:47Z | Invoke specialists on the shared implementation worktree                     |
| #62 EVE-5 tests             | [#65](https://github.com/eskobar95/Optio-New/pull/65) | `0cadc1f` 01:23:09Z | Vitest for skill budget, materialize, specialist share                       |
| — orchestrator image        | [#55](https://github.com/eskobar95/Optio-New/pull/55) | `0bd2503` 01:05:14Z | Real orchestrator intake in Compose (`POST /intake`, `GET /health` on :3100) |
| #45 hello-world             | [#69](https://github.com/eskobar95/Optio-New/pull/69) | `92375b0` 01:26:30Z | Intake → plan path (`GET /hello`, `GET /hello/plan`)                         |
| #14 Laya                    | [#71](https://github.com/eskobar95/Optio-New/pull/71) | `af286a6` 01:30:03Z | Optional CPU Laya Compose profile                                            |
| #22 Caddy                   | [#70](https://github.com/eskobar95/Optio-New/pull/70) | `5cf36c0` 01:38:41Z | Caddy TLS edge for optional intake webhook (profile `edge`, off on boot)     |
| #21 Eve gates               | [#74](https://github.com/eskobar95/Optio-New/pull/74) | `08d0284` 01:38:51Z | Exit gates on Eve phase agents                                               |
| #73 image build             | [#75](https://github.com/eskobar95/Optio-New/pull/75) | `c1e8120` 01:39:03Z | Copy `gateway/` into the eve-runner image                                    |
| #77 port clash              | [#76](https://github.com/eskobar95/Optio-New/pull/76) | `09e1b19` 01:48:02Z | Publish eve-runner on `127.0.0.1:3210`                                       |

## Hello-world e2e

**PASS.** `POST /intake` → plan stage `completed`.

Path: orchestrator on `127.0.0.1:3100`, `HELLO_WORLD_E2E=1 bash scripts/hello-world-e2e.sh` (landed in #69). The script posts intake onto `optio.plan` and polls `GET /hello/plan` until `status` is `completed` and `progressed` is true. `GET /hello` is the demo card (`hello: "world"`, stage `plan`).

## Open issues

None. `gh issue list --state open` was empty after #76 merged and closed #77.

Tracker: https://github.com/eskobar95/Optio-New/issues

## Daytime next steps

- Profile `edge` (Caddy on 80/443) stays off until `OPTIO_NEW_WEBHOOK_HOST` has DNS. Firewall: no inbound rule for 3100, 3200, or 3210.
- Host secrets when those paths are used: `OPTIO_NEW_INTAKE_WEBHOOK_SECRET`, `OPTIO_NEW_GITHUB_TOKEN`, `OPTIO_NEW_GITHUB_WEBHOOK_SECRET`. Provider keys stay on the host. See [docs/secrets.md](docs/secrets.md) and [deploy/README.md](deploy/README.md).
- Profile `laya` stays optional.
