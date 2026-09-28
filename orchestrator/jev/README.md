# orchestrator/jev

Jev decision client for gates, skill-budget, specialist selection, learning thresholds, concurrency, and soft tool-gates.

**v1 base URL:** Vercel AI Gateway (TypeSafe direct paused). Prefer env:

- `OPTIO_NEW_JEV_BASE_URL` or `JEV_BASE_URL` (default `https://ai-gateway.vercel.sh`)
- `OPTIO_NEW_VERCEL_AI_GATEWAY_URL` / `VERCEL_AI_GATEWAY_URL` (alias)

Do **not** point at TypeSafe direct in v1. Swap via env when access reopens. Shared skills/agents never import a concrete Jev client.

Hop 2 plugins (`jev`, `poorjev`, `laya`, `rules`) live in `gateway/jev-router/`. `jev` and `laya` POST `{base}/v1/systemone`. Select one with `OPTIO_NEW_JEV_ROUTER`.

Gate sequence (cascade → plan → skill pick → review pre-screen → intake): [docs/jev-gates.md](../../docs/jev-gates.md). Shared client: `gateway/jev-router/jev-client.ts` (`createJevClient`, pin `jev-1.13.0`).

**Gate #2 (plan) opt-in seam:** `src/orchestrator/jev/plan-gate.ts` — `evaluatePlanWithGate` / `applyPlanGate` after planner, before implement. Not wired into `processStageJob` by default.

**Gate #3 (skill / MCP pick) opt-in seam:** `src/orchestrator/jev/skill-pick-gate.ts` + `skill-pick-port.ts` (`createJevSkillPickPort`). Inject via `createFlueAdapter({ flue: { skillPick, skillRegistry, mcpRegistry, taskType? } })`. Soft timeout → empty selection; hard timeout rethrows. Logs: `onLog` + `createInMemorySkillPickLogStore` / `createDrizzleSkillPickLogStore` → `optio.skill_pick_logs` (requires `workspaceId`). See [docs/jev-gates.md](../../docs/jev-gates.md).

See `docs/SPEC.md` §9 and §14.3.
