# Optional Caveman local proxy (Codex cost-opt)

**Default: off.** Optio-New does not call Caveman Platform or Cloud. The BSL
`caveman-proxy` binary is not in this repo. Operators install the MIT CLI
themselves and point Codex at the loopback listener. Hosted Cloud versus this
path: [docs/caveman-platform-eval.md](../../docs/caveman-platform-eval.md). V1
keeps LiteLLM.

MIT skills under `.cursor/skills/caveman*` (from
[JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman)) are a
separate opt-in (`/caveman`, `/caveman off`). They do not start the proxy.

## Enable path

1. Leave the toggle off until the listener is up. Only the string `true` turns
   it on (`1` and `yes` stay off).

```bash
# .env — copy from .env.example
CAVEMAN_PROXY_ENABLED=false
CAVEMAN_PROXY_URL=http://127.0.0.1:8787
CAVEMAN_MODE=compress
LITELLM_BASE_URL=http://127.0.0.1:4000
# CAVE_SSRF_ALLOWLIST=127.0.0.1
```

2. Install the CLI and the engine **outside** the repo (no vendored binary):

```bash
npm i -g @caveman-ai/cli
caveman setup --install
```

3. Merge [`gateway/caveman/caveman.yaml.example`](../../gateway/caveman/caveman.yaml.example)
   into `~/.caveman/caveman.yaml`. `compat.litellm.base_url` is the LiteLLM
   origin (`http://127.0.0.1:4000`, no `/v1`). `api_key_env` names
   `LITELLM_MASTER_KEY` (the same env Codex sends as `env_key`). Loopback
   upstreams are blocked unless listed in `CAVE_SSRF_ALLOWLIST`.

4. Start the listener. `caveman start` binds `127.0.0.1:8787`. No account:

```bash
CAVEMAN_MODE=compress CAVE_SSRF_ALLOWLIST=127.0.0.1 caveman start
```

5. Flip the toggle and resolve the Codex base URL:

```bash
CAVEMAN_PROXY_ENABLED=true
```

`codexOpenAiBaseUrl()` / `resolveCodexUpstreamBaseUrl()` then returns
`http://127.0.0.1:8787/compat/litellm/v1`. Put that on the Codex provider.
With the toggle false, the same call returns `http://127.0.0.1:4000/v1`
(direct LiteLLM).

```toml
model_provider = "harness_gateway"

[model_providers.harness_gateway]
name = "Optio-New gateway"
base_url = "http://127.0.0.1:8787/compat/litellm/v1" # or :4000/v1 when off
env_key = "LITELLM_MASTER_KEY"
wire_api = "responses"
```

Codex calls `{base_url}/responses`. The compat mount forwards that to
LiteLLM. Cursor stays on the subscription path and does not use this URL.

6. Check the listener (smoke does this when the toggle is exported and the
   CLI exists):

```bash
curl -fsS http://127.0.0.1:8787/health/live
```

`npm run smoke` skips this probe when `CAVEMAN_PROXY_ENABLED` is not `true`,
and skips when `caveman` is not on `PATH`. It does not download a binary.

## Turn it off

Set `CAVEMAN_PROXY_ENABLED=false` (or unset it) and point Codex back at
`http://127.0.0.1:4000/v1`. Stop the listener. Skills can stay installed.

The Compose profile `caveman` is a placeholder process. It does not run the
BSL engine. Use `caveman start` on the host.
