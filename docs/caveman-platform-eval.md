# ADR: Caveman Cloud / Platform (post-V1)

**Status:** Accepted for V1 — keep the current path.  
**Date:** 2026-09-26  
**Issue:** [#16](https://github.com/eskobar95/Optio-New/issues/16)

## Decision

Optio-New V1 does not send traffic to Caveman Cloud or Caveman Platform. The production Codex path stays self-hosted LiteLLM on the VPS. The optional local Caveman proxy stays off by default (`CAVEMAN_PROXY_ENABLED=false`) and, when an operator turns it on, listens on loopback and forwards to that same LiteLLM. This note does not enable a hosted gateway, mint a `CAVE_API_KEY`, or change Compose or env defaults.

## Current Optio path

SPEC §14.2 makes LiteLLM Proxy on the VPS the Codex gateway.

- Codex `openai_base_url` / `model_providers.harness_gateway.base_url` is `${LITELLM_BASE_URL}/v1` (default `http://127.0.0.1:4000/v1`) unless `CAVEMAN_PROXY_ENABLED` is the string `true`.
- With the flag on, Codex uses `http://127.0.0.1:8787/compat/litellm/v1`. The host CLI (`caveman start`, mode `compress` or `record`) forwards to LiteLLM (`gateway/caveman/caveman.yaml.example`). No Caveman account. The BSL engine is not vendored. The Compose `caveman` profile is a placeholder and does not run the engine. Steps: `src/proxy/README.md`.
- Hop 2 routing, cache, and deny stay in the harness (`loadHop2Router` / `applyHop2Decision`), not in a vendor optimizer.
- Provider keys stay in sops/Infisical or gateway env. Codex sends the LiteLLM virtual key; LiteLLM injects the real upstream authorization (SPEC §14.5).
- Cursor CLI stays on the native subscription host. It does not use LiteLLM or Caveman (SPEC §14.1).
- MIT skills under `.cursor/skills/caveman*` are an opt-in reply style (`/caveman`). They do not start a proxy and they do not call Cloud.
- Cost rows are the factory's own: adapter usage (`input_tokens`, `output_tokens`, `cost_usd`) plus OTel. Langfuse is the planned agent UI (`docs/observability.md`). Both exporters default off.

## What Caveman Cloud / Platform offers

Managed product described by the vendored skills (`.cursor/skills/caveman-setup`, `caveman-evidence-review`, `caveman-discover`, `caveman-optimize`, `caveman-manage`). This repo has no Cloud account wired, and this evaluation does not create one.

- Hosted gateway (skill example `https://gateway.caveman.so`) and dashboard (skill example `https://app.caveman.so`).
- Each LLM call is rewritten to `GATEWAY/w/<app>/…` with gateway auth `x-cave-api-key` (`CAVE_API_KEY`).
- Provider keys are either stored encrypted in Caveman (`PROVIDER_KEYS: stored`) or sent per request (`byok`, header `x-cave-upstream-key`).
- **Record** mode measures what the app sends and what it costs, and does not change model-visible bytes. Verified savings stay $0 until an optimizer is turned on and passes an eval gate.
- Spend can be grouped by app slug and by workflow labels (`caveman-discover`).
- Evidence review keeps four buckets separate: measured provider-complete list-price cost, inferred daily headroom, verified ledger savings, and evidence cost. Those numbers are not added together.
- Optimization observations are report-only until an operator picks one candidate and a paired baseline evaluation.
- Experiments (start, approve, cancel, promote, rollback) are a Cloud lifecycle with server-side guardrails.

LiteLLM can be pointed at that hosted gateway (`api_base` plus extra headers). That would replace or wrap the V1 upstream. This repo does not do that.

## Cost and operations

| Topic         | Current path                                                                           | Caveman Cloud / Platform                                                                                          |
| ------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Gateway       | Self-hosted LiteLLM. Optional loopback compress proxy, default off.                    | Hosted gateway. Prompts and usage leave the VPS.                                                                  |
| Keys          | Virtual LiteLLM key at the CLI. Real provider keys in sops/Infisical.                  | `CAVE_API_KEY`, plus cloud-stored provider keys or BYOK headers.                                                  |
| Routing       | JevRouter Hop 2: subscription pool, alt API, cache, deny.                              | Vendor routing, cache, and optimizers behind their experiment gate.                                               |
| Measurement   | Our usage rows and OTel. Langfuse and SigNoz stay off until flagged.                   | Dashboard traces, Cave Score, workflow buckets. Useful after real traffic is recorded.                            |
| Token savings | Local `compress` can shrink prompts on loopback. That is not a verified dollar ledger. | Verified savings need record mode, then an optimizer that passes eval. Until then the product rule is savings $0. |
| Cash          | Provider invoices plus the VPS. No Caveman subscription.                               | Provider invoices remain. Platform fee is unknown here — this note does not assume a price.                       |
| Ops           | We run LiteLLM, Redis, Postgres, and workers. The failure domain is the VPS.           | Extra vendor: availability, egress, retention, region, terms. A dual hop adds a second outage.                    |
| Cursor        | Native subscription path.                                                              | A hosted OpenAI-compatible gateway does not unlock Cursor CLI custom models. SPEC §14.1 still forbids MITM.       |
| Scope         | Self-hosted factory. Secrets stay out of git.                                          | Puts a multi-tenant SaaS on the request path. Multi-tenant SaaS is a V1 non-goal.                                 |

## Recommendation

Keep the current path for V1.

- Codex production upstream remains local LiteLLM (`LITELLM_BASE_URL`, default `http://127.0.0.1:4000`).
- `CAVEMAN_PROXY_ENABLED` stays `false` in `.env.example` and `secrets/.env.example`.
- Do not set `CAVE_GATEWAY_URL`, `CAVE_API_KEY`, or `https://gateway.caveman.so` in default config, Compose, or adapters.
- Do not vendor `@caveman-ai/cli` or require a Caveman login for `npm run ci`.
- Loading `.cursor/skills/caveman-setup` is not authorization to wire this repository to Cloud. The four setup values (`GATEWAY`, `CAVE_API_KEY`, `PROVIDER_KEYS`, `DASHBOARD`) are intentionally absent.

## When to reconsider (exit criteria)

Reopen this ADR only after V1 is running real Codex → LiteLLM traffic, and only when every item below is true. Meeting them authorizes a **record-only pilot**, not a default cutover.

1. **Ledger.** Adapter usage rows (SPEC §13.4) exist for a representative window: tokens, `cost_usd`, model, provider, `task_id`, and step. A smoke run with empty provider keys is not that window.
2. **Local observability.** Langfuse or the in-process OTel path can show the same runs, so a Cloud dashboard is a comparison and not the only copy of spend.
3. **Gap, in our numbers.** A written delta where Cloud's measured list-price (or a passed optimizer) beats LiteLLM cache plus the optional local proxy by enough to pay for platform fees, egress, and the ops change. Vendor marketing figures do not count.
4. **Data handling.** A written choice on prompt and trace retention, region, and `stored` versus `byok`. Provider keys stay out of git. Storing keys in Caveman is an explicit exception to "keys live in sops/Infisical", not a silent default.
5. **Cursor stays out.** Cloud does not become a Cursor MITM. Revisit Cursor only if Cursor ships a real custom model endpoint (SPEC §14.1).
6. **Pilot shape.** New Bot (human in chat) accepts a non-production app slug, record mode only, no optimizer. Rollback is Codex `base_url` back to local LiteLLM and the Cloud key removed from env.
7. **Bar before any default change.** A fixed fixture, no quality regression, provider-complete cost compared with the LiteLLM baseline, and error rate plus latency inside the same budget and deny behavior as SPEC §14.6. A follow-up ADR accepts or rejects flipping the default. This file does not pre-approve that flip.

Until those exit criteria are met, do not point factory traffic at Caveman Cloud.

## Consequences

- No new production dependency, and no behavior change in adapters, Compose, or env defaults.
- Operators who want loopback compression keep using `src/proxy/README.md`. That path is not Cloud.

## References

- GitHub issue #16
- `src/proxy/caveman.ts`, `src/proxy/README.md`, `gateway/caveman/caveman.yaml.example`, `gateway/litellm/README.md`
- SPEC §13.4, §14.1–§14.6
- `docs/observability.md`
- `.cursor/skills/caveman-setup`, `caveman-evidence-review`, `caveman-discover`, `caveman-optimize`, `caveman-manage`
