# gateway/litellm

Example LiteLLM Proxy config for Hop 2 (SPEC §14.2). Compose mounts `config.yaml.example` at `/app/config.yaml` and publishes loopback `${OPTIO_NEW_LITELLM_HOST_PORT:-4000}`.

## Example models

| `model_name`    | Hop 2 choice        | Upstream in the example                                                          |
| --------------- | ------------------- | -------------------------------------------------------------------------------- |
| `gpt-4o`        | `subscription_pool` | `openai/gpt-4o` via `OPENAI_API_KEY`                                             |
| `claude-sonnet` | `alt_api`           | `anthropic/claude-sonnet-4-20250514` via `ANTHROPIC_API_KEY`                     |
| `cache-exact`   | `cache` (label)     | same OpenAI model; exact hits are served by `applyHop2Decision` before the proxy |

`general_settings.master_key` is `LITELLM_MASTER_KEY`. No provider keys are committed. `litellm_settings.cache_params.type` is `local` so the service can become healthy without Redis.

## Health

The Compose service checks `GET /health/liveliness` on port 4000. From the host, after `docker compose up -d redis postgres litellm`:

```bash
curl -fsS http://127.0.0.1:4000/health/liveliness
```

Liveliness does not call the example models. A chat completion still needs real provider keys in the env (sops/Infisical — see `docs/secrets.md`).

## Hop 2 plugins

Routing is not a LiteLLM Python callback. The harness calls `loadHop2Router` and `applyHop2Decision` first (`gateway/jev-router/README.md`). Codex keeps `base_url` on this proxy (`LITELLM_BASE_URL`, or the Caveman compat mount when that proxy is enabled).
