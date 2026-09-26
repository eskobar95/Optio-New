# gateway/jev-router

Swappable `JevRouter` plugins for Hop 2 (Codex path: subscription_pool | alt_api | cache | deny) and shared decision surface.

Hop 1 (which CodingAgent backend) is served by the kit-harness sidecar, not this folder. See `docs/kit-harness.md`.

Implementations: `jev` | `poorjev` | `laya` | `rules`.

The `jev` plugin points at **Vercel AI Gateway** in v1 (`JEV_BASE_URL` / `VERCEL_AI_GATEWAY_URL`), not TypeSafe direct.
