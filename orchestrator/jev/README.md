# orchestrator/jev

Jev decision client for gates, skill-budget, specialist selection, learning thresholds, concurrency, and soft tool-gates.

**v1 base URL:** Vercel AI Gateway (TypeSafe direct paused). Prefer env:

- `OPTIO_NEW_JEV_BASE_URL` or `JEV_BASE_URL` (default `https://ai-gateway.vercel.sh`)
- `OPTIO_NEW_VERCEL_AI_GATEWAY_URL` / `VERCEL_AI_GATEWAY_URL` (alias)

Do **not** point at TypeSafe direct in v1. Swap via env when access reopens. Shared skills/agents never import a concrete Jev client.

See `docs/SPEC.md` §9 and §14.3.
