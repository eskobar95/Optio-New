# orchestrator/routing

**Hop 1** JevRouter: which CodingAgent backend (`cursor_subscription` | `codex_gateway` | future). Respects quotas, cost budgets, and step `coding_backend` overrides; fail closed if undecided.

The runnable Hop 1 API is the **kit-harness** sidecar (`src/kit-harness/`, Compose profile `harness`). See `docs/kit-harness.md`. This folder stays the routing notes; workers are not wired to the sidecar yet.

Hop 2 (Codex upstream/cache/deny) lives under `gateway/jev-router/`.

See `docs/SPEC.md` §14.4.
