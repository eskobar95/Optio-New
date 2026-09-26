# Optional Caveman local proxy (cost-opt)

**Default: off.** Optio-New does **not** require Caveman Cloud / Platform (post-V1).

## Skill (token-efficient replies)

MIT skills under `.cursor/skills/caveman*` (from [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman)).

- Activate in Cursor: `/caveman` (or invoke the caveman skill).
- Disable: `/caveman off`.
- Opt-in only — not forced on all agents.

## Local proxy runtime (not vendored)

Install CLI yourself (BSL engine stays outside this repo):

```bash
npm i -g @caveman-ai/cli
caveman setup --install
CAVEMAN_MODE=compress caveman start
# default listen: http://127.0.0.1:8787
```

Or Compose profile (optional stub):

```bash
docker compose --profile caveman up -d caveman-proxy
```

## Wire into Optio-New

```bash
# .env
CAVEMAN_PROXY_ENABLED=true
CAVEMAN_PROXY_URL=http://127.0.0.1:8787
CAVEMAN_MODE=compress
```

When enabled, point Codex `openai_base_url` / gateway upstream at `CAVEMAN_PROXY_URL` via `resolveCodexUpstreamBaseUrl()` in `caveman.ts`. When disabled, CodingAgent/Codex keep the direct LiteLLM path.
