# adapters/codex

OpenAI Codex CLI CodingAgent adapter. `run()` writes a user-level `$CODEX_HOME/config.toml` (outside the worktree) and spawns `codex exec --json`. `openai_base_url` and `model_providers.harness_gateway.base_url` both come from `codexOpenAiBaseUrl()` (`wire_api = "responses"`).

- **Default** (`CAVEMAN_PROXY_ENABLED` unset or not `true`): local LiteLLM at `http://127.0.0.1:4000/v1` (`LITELLM_BASE_URL`).
- **Enabled:** local Caveman compat mount `http://127.0.0.1:8787/compat/litellm/v1`, started with `caveman start` on the host. The BSL binary is not vendored. Platform/Cloud is not required. See `src/proxy/README.md`.

Secrets never committed. `env_key` is `LITELLM_MASTER_KEY` (the name only; the value stays in the process env).

Implements the shared `CodingAgent` interface in `../../src/adapters/coding-agent.ts`. Pick it with `resolveCodingBackend({ stepCodingBackend: "codex" })`. Hop 2 upstream/cache/deny is `loadHop2Router` in `gateway/jev-router/`, not an import from this adapter.
