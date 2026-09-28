# gateway/jev-router

Swappable Hop 2 `JevRouter` plugins (SPEC §14.3–§14.6). CodingAgent adapters do not import a concrete plugin. Call `loadHop2Router` / `loadConfiguredHop2Router`, then `applyHop2Decision`, before forwarding to LiteLLM.

Hop 1 (which CodingAgent backend) is served by the kit-harness sidecar, not this folder. See `docs/kit-harness.md`.

**Soft Jev gates (ENG-25):** ordered cascade / plan / skill-pick / review / intake contracts live in `gates/` with shared `createJevClient` (`jev-1.13.0`, timeout → passthrough). Documented in [docs/jev-gates.md](../../docs/jev-gates.md). Gates #1 (`backend_cascade`) and #2 (`plan`) are implemented; #3–5 are stub types. Hop-2 plugins above stay fail-closed and unchanged.

**Mid-run MCP (ENG-27):** soft `jev_evaluate` / `jev_decide` for Cursor CLI live in `mcp/` — stdio Content-Length JSON-RPC, soft timeout → passthrough. See [docs/jev-mcp.md](../../docs/jev-mcp.md). Run with `npm run jev-mcp`.

```ts
interface JevRouter {
  decide(state: RoutingState): Promise<RoutingDecision>;
}
// choice ∈ subscription_pool | alt_api | cache | deny
// plugin id ∈ jev | poorjev | laya | rules
```

`OPTIO_NEW_JEV_ROUTER` (alias `JEV_ROUTER`) selects the plugin. If it is unset, `loadConfiguredHop2Router` throws. There is no implicit plugin.

## Plugins

| Id        | Behavior                                                                                                                                                                                                                                                                                               |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `rules`   | No network. Hard deny when `quota_snapshot.budget_exhausted` is true. Exact `prompt_hash` in `cached_prompt_hashes` → `cache`. Otherwise subscription quota, then alt quota. Missing snapshot → `deny` (`ambiguous`).                                                                                  |
| `poorjev` | Same budget and exact-cache rules. A missing snapshot defaults to `subscription_pool` / `gpt-4o` (`poorjev_default`).                                                                                                                                                                                  |
| `jev`     | `POST {JEV_BASE_URL}/v1/systemone`. Fail closed (`deny`) on network errors, non-OK HTTP, or an unknown choice.                                                                                                                                                                                         |
| `laya`    | Same `/v1/systemone` body against `OPTIO_NEW_LAYA_URL` (default `http://127.0.0.1:8000`). Model is omitted unless `LAYA_MODEL` is set. Compose profile `laya` is off by default and serves a CPU placeholder that returns `deny` ([docs/laya.md](../../docs/laya.md)). NVIDIA toolkit is not required. |

Example model ids match `gateway/litellm/config.yaml.example`: `gpt-4o`, `claude-sonnet`, `cache-exact`.

## `JEV_BASE_URL` → Vercel AI Gateway

v1 hosted Jev is **not** TypeSafe direct. The `jev` plugin base URL is:

1. `OPTIO_NEW_JEV_BASE_URL`
2. `JEV_BASE_URL`
3. `OPTIO_NEW_VERCEL_AI_GATEWAY_URL`
4. `VERCEL_AI_GATEWAY_URL`
5. default `https://ai-gateway.vercel.sh`

The client appends `/v1/systemone` (a base that already ends in `/v1` is not doubled). Swap the base URL when TypeSafe access returns; adapters stay unchanged. Bearer token: `OPTIO_NEW_JEV_API_KEY` or `JEV_API_KEY`. Hosted model field defaults to `jev-latest` (`JEV_MODEL`).

## Cache and deny

`applyHop2Decision` (SPEC §14.6):

- **cache** — returns the stored chat completion, `route=cache`, `upstreamTokens: 0`. A miss becomes deny.
- **deny** — HTTP **429**. `reason: budget_exhausted` maps to CodingAgent `budget_exhausted`. Any other deny maps to `rate_limited`.
- **subscription_pool / alt_api** — forward to the example LiteLLM `model_name`.

LiteLLM's own local cache is only for forwarded calls. The proxy does not host these TypeScript plugins (LiteLLM callbacks are Python).

## Task caps (orchestrator)

The orchestrator enforces a separate per-task cap around agent steps: default **200000 tokens** and **USD 2** (`OPTIO_TASK_MAX_TOKENS`, `OPTIO_TASK_MAX_USD`, or `budget` in `workflows/default-task.yaml`). Those numbers are the hard stop for a Hetzner CX33 host using this Gateway as pass-through: one coding slice, not an open retry loop. Exceeding the cap, or omitting usage for a capped dimension, throws `BudgetExceeded` and does not run later BullMQ stages.

This router does not raise that cap. A Hop 2 `deny` is still HTTP 429 (`budget_exhausted` or `rate_limited`). A task under its cap does not turn a `deny` into a forward. See [docs/task-budget.md](../../docs/task-budget.md).
