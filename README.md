# Optio-New

Self-hosted coding-agent factory — **BullMQ** pipeline, **New Bot** decision layer, Cursor skills.

**Directory:** `Optio-New` (sibling of the separate `~/Projects/optio` product monorepo — do not merge).  
**Compose project name:** `optio-new`  
**Package:** `@optio-new/harness`  
**Env prefix:** `OPTIO_NEW_`

## Spec

Authoritative design: **[docs/SPEC.md](docs/SPEC.md)**  
Tree → section map: **[MAP.md](MAP.md)**  
Skeleton source copy: `specs/agent-harness-skeleton-spec.md`

## Architecture (v1)

- **New Bot** (Grok Bot) decides what to build, receives feedback, and drives stage gates.
- **BullMQ + Redis** orchestrates the pipeline: plan → implement → review → ready → merge (SPEC §14.0).
- **Linear product integration is out** (ADR in SPEC §8). Optional intake webhook later for New Bot / CI.
- Eve agents, adapters (Cursor/Codex), Jev via Vercel AI Gateway, and optional Laya remain as designed.
- **kit-harness** is the local decision sidecar (Hop-1 route, tool-gate, completion, loop, split). New Bot stays intake. Compose profile `harness`.

## Language & layout

- **TypeScript** is the standard language (`src/`, strict `tsconfig.json`, Node 20+ ESM).
- Top-level: `src/` (harness TS), `tests/`, `docs/`, plus config/content dirs (`agents/`, `.cursor/`, `workflows/`, Compose).
- See **[AGENTS.md](AGENTS.md)** for how New Bot, BullMQ, Eve agents, and skills work together.

## Cursor-native SoT (in-repo)

Skills and specialist agents live under **this repo’s** `.cursor/skills/` and `.cursor/agents/`.  
`skills/index.json` and `specialists/index.json` point here.  
Staging folders `harness/staging/` and `specs/harness-working-skills/` are **historical snapshots** only.

## Quick layout

Project root **is** the harness tree (`agents/`, `specialists/`, `skills/`, `workflows/`, `orchestrator/`, `adapters/`, `gateway/`, `state/`, `docs/`, `.cursor/`) plus ops files (`docker-compose.yml`, `Caddyfile`, `deploy/`, `secrets/`, `scripts/`).

## Local setup

```bash
npm install          # also installs Husky pre-commit hooks via prepare
cp .env.example .env   # edit locally; never commit real secrets
bash scripts/smoke-local.sh
```

Optional data plane:

```bash
docker compose up -d redis postgres litellm
docker compose --profile laya up -d laya
docker compose --profile edge up -d caddy
docker compose --profile harness up -d --build kit-harness
curl -s http://127.0.0.1:3200/health
```

Decision sidecar: **[docs/kit-harness.md](docs/kit-harness.md)**. A default `docker compose up` does not start `kit-harness`. Bound to `127.0.0.1:3200`.

Docker Desktop on a Mac (config check, then isolated up/down of redis, postgres, and litellm):

```bash
bash scripts/smoke-compose-mac.sh
```

See [docs/mac-compose-smoke.md](docs/mac-compose-smoke.md). GitHub Actions stays on `scripts/smoke-local.sh` (`--config-only` when Docker is present).

Secrets on the Hetzner kit-harness (`/opt/optio-new`): **sops + age**. Runbook: [docs/secrets.md](docs/secrets.md).
Postgres backup example: `scripts/backup-postgres-to-storagebox.sh.example`.

## CI and pre-commit (always on)

- **GitHub Actions:** [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on **every push** and **every pull_request** (any branch for push; PRs targeting `main`). Runs `format:check`, `lint`, `typecheck`, `test` (Vitest), and `smoke`. Failures fail the workflow.
- **Pre-commit:** Husky + lint-staged (`.husky/pre-commit`) installs via `npm install` (`prepare` → `husky`). Formats/lints staged files and runs `typecheck` (no Docker required).
- **Tooling:** ESLint + Prettier + Vitest + `tsc --noEmit`. Scripts: `lint`, `lint:fix`, `format`, `format:check`, `typecheck`, `test`, `test:watch`, `smoke`, `smoke:compose`, `ci`, `status`, `kit-harness`.

## Optional: Caveman cost-opt

**Opt-in only** (default off). MIT skills from [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) live under `.cursor/skills/caveman*`. Full steps: [src/proxy/README.md](src/proxy/README.md).

- **Skill:** in Cursor, `/caveman` (levels: `lite|full|ultra|…`) · `/caveman off` to disable. Not forced on all agents. This does not start the proxy.
- **Local proxy (no Platform/Cloud, no vendored BSL binary):**
  1. `npm i -g @caveman-ai/cli && caveman setup --install`
  2. Merge `gateway/caveman/caveman.yaml.example` into `~/.caveman/caveman.yaml` (LiteLLM at `http://127.0.0.1:4000`).
  3. `CAVEMAN_MODE=compress CAVE_SSRF_ALLOWLIST=127.0.0.1 caveman start` (listens on `127.0.0.1:8787`).
  4. Set `CAVEMAN_PROXY_ENABLED=true` (see `.env.example`). Codex `base_url` becomes `http://127.0.0.1:8787/compat/litellm/v1`. With the flag false, Codex stays on LiteLLM `http://127.0.0.1:4000/v1`.
- **Smoke:** `npm run smoke` probes `/health/live` only when the flag is `true` and `caveman` is on `PATH`. Otherwise it skips. The Compose `caveman` profile is a placeholder and does not run the engine.
- **Skip for V1:** Caveman Platform / Cloud managed gateway.

## First issue / Getting started

## First issue / Getting started

1. Copy `.env.example` → `.env` (no real secrets in git). On the VPS, encrypt it with `scripts/secrets.sh` ([docs/secrets.md](docs/secrets.md)).
2. `npm install` then `npm run ci`.
3. Grab the **good first issue**: implement `src/agent/loop.ts` (prompt → model adapter → response) with a Vitest mock — see [issues labeled good first issue](https://github.com/eskobar95/Optio-New/issues/1).
4. Read [AGENTS.md](AGENTS.md), [CONTRIBUTING.md](CONTRIBUTING.md), and [docs/SPEC.md](docs/SPEC.md) §8 / §14.0.

License: [MIT](LICENSE).

## Jev (v1)

`jev` router base URL → **Vercel AI Gateway** (`JEV_BASE_URL` / `VERCEL_AI_GATEWAY_URL`, default `https://ai-gateway.vercel.sh`). Not TypeSafe direct.

## Status

Live bootstrap snapshot: **[docs/status.md](docs/status.md)** (CI badge and open issues).

Refresh it locally with GitHub CLI (`gh auth login`), then:

```bash
npm run status
```

The script is idempotent: a second run does not rewrite the file when the CI conclusion and the open-issue list are unchanged. [`.github/workflows/status.yml`](.github/workflows/status.yml) runs the same command daily, on manual dispatch, and after CI completes on `main`. `npm run ci` does not call it.
