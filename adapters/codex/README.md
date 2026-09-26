# adapters/codex

OpenAI Codex CLI CodingAgent adapter. `codexOpenAiBaseUrl()` is the
`model_providers.harness_gateway` `base_url` (`wire_api = "responses"`).

- **Default** (`CAVEMAN_PROXY_ENABLED` unset or not `true`): local LiteLLM at `http://127.0.0.1:4000/v1` (`LITELLM_BASE_URL`).
- **Enabled:** local Caveman compat mount `http://127.0.0.1:8787/compat/litellm/v1`, started with `caveman start` on the host. The BSL binary is not vendored. Platform/Cloud is not required. See `src/proxy/README.md`.

Secrets never committed. `env_key` is `LITELLM_MASTER_KEY`.

Implements the shared `CodingAgent` interface in `../../src/adapters/coding-agent.ts`. The `run()` body is still a stub; it does not spawn Codex.
