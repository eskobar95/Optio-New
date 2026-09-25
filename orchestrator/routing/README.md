# orchestrator/routing

**Hop 1** JevRouter: which CodingAgent backend (`cursor_subscription` | `codex_gateway` | future). Respects quotas, cost budgets, and step `coding_backend` overrides; fail closed if undecided.

Hop 2 (Codex upstream/cache/deny) lives under `gateway/jev-router/`.

See `docs/SPEC.md` §14.4.
