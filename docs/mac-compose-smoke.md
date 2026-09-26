# Mac local verify — Docker Desktop compose smoke

Issue [#23](https://github.com/eskobar95/Optio-New/issues/23).

GitHub Actions runs `scripts/smoke-local.sh` on `ubuntu-latest`. That job syntax-checks `scripts/smoke-compose-mac.sh` and, when the Docker CLI is on `PATH`, runs it with `--config-only`. Compose up stays on this Mac script. There is no macOS runner. `SMOKE_COMPOSE_UP=1` is a separate path that only starts redis and postgres and leaves them running.

## Command

On a Mac with Docker Desktop running (Compose v2, repo under a shared path such as `/Users`):

```bash
cp .env.example .env   # optional; the script falls back to .env.example
bash scripts/smoke-compose-mac.sh
```

`npm run smoke:compose` is the same script. It is not part of `npm run ci`.

The script:

1. Reads repo-root `.env` when that file exists, otherwise `.env.example`. It does not write `.env` and does not print the rendered config.
2. Renders `docker compose config` and checks host ports.
3. Asserts default services include `redis`, `postgres`, and `litellm`.
4. Asserts `orchestrator` and `eve-runner` appear only with `--profile full` (those services are not started).
5. `up -d` / health-check / `down -v` on Compose project `optio-new-mac-smoke`.

| Service  | Host port | Check                                     |
| -------- | --------- | ----------------------------------------- |
| redis    | 16379     | `redis-cli ping` → `PONG`                 |
| postgres | 15432     | `pg_isready`                              |
| litellm  | 14000     | `GET /health/liveliness` (or `/liveness`) |

Default `docker compose up -d redis postgres litellm` still binds `127.0.0.1:6379`, `5432`, and `4000`. The smoke project uses the other ports so it does not stop that stack. Override with `OPTIO_NEW_SMOKE_*` (see `--help`).

`--config-only` skips pull and up. `--keep` leaves the smoke stack running.

## Gaps

- Docker Desktop up/down is a local Mac run. GitHub Actions covers script syntax and `--config-only` when the Docker CLI is on `PATH`.
- LiteLLM uses the floating tag `ghcr.io/berriai/litellm:main-latest`. The first pull is large. Confirm arm64 on Apple Silicon when you run the script.
- Health is process liveliness only. `/health` calls models and needs provider keys. `.env.example` leaves `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` empty on purpose.
- Profiles left stopped: `full` (orchestrator, eve-runner), `laya`, `edge` (Caddy on 80/443), `observability`, `caveman`.
- Placeholders in `.env.example` (`changeme`, `sk-change-me`) are not production secrets. Do not commit `.env`.

## If it fails

File a GitHub issue with the `[smoke-compose]` lines and the Docker Desktop version. Do not paste `.env`. No follow-up issue is opened until a run actually fails.
