# Jev gate sequence (ENG-25)

Ordered soft-decision gates for the Optio factory. **Jev lives in Optio only** — never as the Cursor session LLM. Wire protocol: `POST /v1/systemone`, pinned model **`jev-1.13.0`**.

Shared client: `createJevClient` in `gateway/jev-router/jev-client.ts` (inject `fetch`, AbortSignal timeout). Soft gates **timeout → passthrough**. Hard policy stays deterministic code.

DB attachment: `optio.stage_jev_gates.gate_kind` (`jev_gate_kind` enum from ENG-24).

## Ordered rollout

| #   | `gate_kind`        | Purpose                                                    | Labels / outcome                                                        | Status          |
| --- | ------------------ | ---------------------------------------------------------- | ----------------------------------------------------------------------- | --------------- |
| 1   | `backend_cascade`  | Backend / model cascade per issue complexity               | `flue_cheap` \| `cursor_composer` \| `cursor_frontier` \| `needs_human` | **Implemented** |
| 2   | `plan`             | Plan / spec quality; auto-clear high-confidence safe plans | `auto_clear` \| `needs_revision` \| `needs_human`                       | **Implemented** |
| 3   | `skill_pick`       | Which skills / MCP tools to inject before spawn            | `skill_ids[]` + optional `mcp_tool_ids[]` + confidence                  | **Implemented** |
| 4   | `review_prescreen` | Filter diffs before human review (Hannes)                  | `forward` \| `filter` \| `needs_human`                                  | Stub types only |
| 5   | `intake`           | Classify Linear / intake issues                            | `enqueue` \| `clarify` \| `reject` \| `needs_human`                     | Stub types only |

## Shared mechanics

| Knob                      | Default           | Notes                                       |
| ------------------------- | ----------------- | ------------------------------------------- |
| Model                     | `jev-1.13.0`      | `PINNED_JEV_MODEL`                          |
| `timeoutMs`               | `30000`           | Matches `stage_jev_gates.timeout_ms`        |
| `passthroughOnTimeout`    | `true`            | Soft gates fail open                        |
| `minConfidence` (cascade) | `0.7`             | Below threshold → passthrough               |
| `minConfidence` (plan)    | `0.7`             | Below threshold → passthrough               |
| `minConfidence` (skill)   | `0.7`             | Below threshold → passthrough               |
| Base URL                  | Vercel AI Gateway | Same env chain as Hop-2 `resolveJevBaseUrl` |

Confidence thresholds are **configurable per gate / stage** (JSON `config` on `stage_jev_gates`). No day-one manual threshold tuning required — ship defaults; learn from logs later.

## Gate #1 — backend cascade

### Input

```ts
{
  state: {
    task_id?: string;
    workflow_id?: string;
    step_id?: string;
    issue_title?: string;
    issue_body?: string;
    estimated_complexity?: "low" | "medium" | "high" | "unknown";
    // passthrough extras allowed
  };
  config?: {
    minConfidence?: number;      // default 0.7
    timeoutMs?: number;          // default 30000
    passthroughOnTimeout?: boolean; // default true
  };
}
```

SystemOne body: `{ state, questions: { backend_cascade: … }, model: "jev-1.13.0" }`.

### Output

| Outcome                       | When                                                                          | Caller action                                             |
| ----------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------- |
| `decided` + `flue_cheap`      | confidence ≥ min                                                              | Prefer Flue (`backend: "flue"`)                           |
| `decided` + `cursor_composer` | confidence ≥ min                                                              | Cursor + `modelTier: "composer"`                          |
| `decided` + `cursor_frontier` | confidence ≥ min                                                              | Cursor + `modelTier: "frontier"`                          |
| `escalate` + `needs_human`    | confidence ≥ min                                                              | Do **not** spawn CodingAgent                              |
| `passthrough`                 | timeout (when enabled), HTTP/network, invalid body, undecided, low confidence | Fall back to `resolveCodingBackend`                       |
| `error`                       | timeout when `passthroughOnTimeout: false`                                    | `applyBackendCascade` throws `BackendCascadeTimeoutError` |

### Hook (opt-in)

```ts
import { createJevClient, resolveCodingBackendWithCascade } from "@optio/…"; // via src/index

const client = createJevClient({ fetchImpl, env });
const decision = await resolveCodingBackendWithCascade(
  { defaultBackend: "cursor" },
  { client, state },
);
// decision.kind === "backend" | "escalate"
// hard timeout (passthroughOnTimeout: false) throws BackendCascadeTimeoutError
```

`resolveCodingBackend` itself is **unchanged** and remains the production default. Cascade is opt-in so Flue is never forced. `applyBackendCascade` maps a precomputed outcome; `resolveCodingBackendWithCascade` runs the gate then maps.

## Gate #2 — plan / spec

Runs after the planner stage and before implement. Scores plan quality; auto-clears high-confidence safe plans.

### Input

```ts
{
  state: {
    task_id?: string;
    workflow_id?: string;
    step_id?: string;
    plan_text?: string;
    task_type?: string;          // logged for feedback loop
    issue_title?: string;
    issue_body?: string;
    // passthrough extras allowed
  };
  config?: {
    minConfidence?: number;      // default 0.7
    timeoutMs?: number;          // default 30000
    passthroughOnTimeout?: boolean; // default true
  };
}
```

SystemOne body: `{ state, questions: { plan: … }, model: "jev-1.13.0" }`.

### Output

| Outcome                      | When                                                                          | Caller action (`applyPlanGate`)                                          |
| ---------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `decided` + `auto_clear`     | confidence ≥ min                                                              | `action: "proceed"` — continue to implement                              |
| `decided` + `needs_revision` | confidence ≥ min                                                              | `action: "revise"` — send back for replan                                |
| `escalate` + `needs_human`   | confidence ≥ min                                                              | `action: "escalate"` — HITL                                              |
| `passthrough`                | timeout (when enabled), HTTP/network, invalid body, undecided, low confidence | `action: "proceed"` + `source: "passthrough"` — continue to implement    |
| `error`                      | timeout when `passthroughOnTimeout: false`                                    | `applyPlanGate` throws `PlanGateTimeoutError` (still logged via `onLog`) |

### Hook (opt-in)

```ts
import { createJevClient, evaluatePlanWithGate } from "@optio/…"; // via src/index

const client = createJevClient({ fetchImpl, env });
const decision = await evaluatePlanWithGate({
  client,
  state: { task_id: "t1", plan_text: "…", task_type: "bugfix" },
  onLog: (entry) => {
    // feedback loop: task_type + outcome (+ label/confidence/reason)
  },
});
// Continue when decision.action === "proceed" (auto_clear or soft passthrough).
// Soft fail-open: source === "passthrough". Hard timeout throws PlanGateTimeoutError after onLog.
```

`processStageJob` is **unchanged** and remains the production default. Plan gate is opt-in: `runPlanGate` produces the outcome; `applyPlanGate` maps it; `evaluatePlanWithGate` runs both and logs once (including hard timeout).

## Gate #3 — skill / MCP pick

Runs before Flue / CodingAgent spawn. Jev observes the **full skill registry** (and optional MCP registry) — the allow-list max — and selects a **per-task subset**. Soft timeout → empty selection (no cold reload of the whole library). Pin **`jev-1.13.0`**. Jev is never the Cursor session LLM.

### Input

```ts
{
  state: {
    task_id?: string;
    workflow_id?: string;
    step_id?: string;
    stage?: string;
    prompt?: string;
    task_type?: string;          // logged for feedback loop
    skill_registry?: string[];   // allow-list max (required for useful picks)
    mcp_registry?: string[];     // allow-list max for MCP capabilities/tools
    issue_title?: string;
    issue_body?: string;
  };
  config?: {
    minConfidence?: number;      // default 0.7
    timeoutMs?: number;          // default 30000
    passthroughOnTimeout?: boolean; // default true
  };
}
```

SystemOne body: `{ state, questions: { skill_pick: … }, model: "jev-1.13.0" }`.

### Output

| Outcome       | When                                                                        | Caller action (`applySkillPick`)                                        |
| ------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `decided`     | confidence ≥ min; ≥1 id remains after registry filter                       | `source: "skill_pick"` + subset `skillIds` / `mcpToolIds`               |
| `passthrough` | timeout (soft), HTTP/network, undecided, low confidence, **filtered_empty** | `source: "passthrough"` + **empty** ids (do not inject full allow-list) |
| `error`       | timeout when `passthroughOnTimeout: false`                                  | throws `SkillPickTimeoutError` (Flue rethrows; still logged)            |

Selected ids outside the registries are dropped (`filterToRegistry`).

### Hook (opt-in)

```ts
import {
  createJevClient,
  createJevSkillPickPort,
  createInMemorySkillPickLogStore,
  evaluateSkillPickWithGate,
} from "@optio/…"; // via src/index

const client = createJevClient({ fetchImpl, env });
const logStore = createInMemorySkillPickLogStore(); // or DB-backed → optio.skill_pick_logs

const decision = await evaluateSkillPickWithGate({
  client,
  state: {
    task_id: "t1",
    task_type: "bugfix",
    prompt: "…",
    skill_registry: ["tdd", "code-review", "bot-session"],
    mcp_registry: ["read", "shell"],
  },
  logStore,
  workspaceId: "…",
  onLog: (entry) => {
    // feedback: task_type + selected_skill_ids + outcome
  },
});
// decision.source === "skill_pick" | "passthrough"

// Flue wiring: inject port so dispatch instructions carry the pick (not full bodies)
const skillPick = createJevSkillPickPort({ client, logStore, workspaceId: "…" });
createFlueAdapter({ flue: { skillPick, skillRegistry: […], mcpRegistry: […] } });
```

`processStageJob` is **unchanged**. Default Flue adapter still uses `createPassthroughJevSkillPick()` (empty). Prefer `createJevSkillPickPort` when Optio has a Jev client. Flue merges `formatSkillPickInstructions` into `dispatch` instructions before `start` — lazy catalog ids only, not cold-loading skill bodies.

Logs: `onLog` always; optional `SkillPickLogStore.append` → `optio.skill_pick_logs` (`task_type`, `selected_skill_ids`, `outcome`).

## Gates #4–5 (documented stubs)

Zod answer shapes live in `gateway/jev-router/gates/types.ts` (`ReviewPrescreenAnswerSchema`, `IntakeTriageAnswerSchema`). No runners in this PR.

## Non-goals (this slice)

- Jev as Cursor session LLM
- Code generation via Jev
- ENG-36 Flue session store ownership
- UI
- Rewriting kit-harness `/v1/route-model` Hop-1 labels (`cursor_subscription` / `codex_gateway`)

Mid-run Cursor MCP soft tools: [jev-mcp.md](jev-mcp.md) (ENG-27).

## Related code

- Client: `gateway/jev-router/jev-client.ts`
- Cascade: `gateway/jev-router/gates/cascade.ts`
- Plan: `gateway/jev-router/gates/plan.ts`
- Skill pick: `gateway/jev-router/gates/skill-pick.ts`
- Hop-1 helper: `src/adapters/select.ts` (`applyBackendCascade`)
- Plan seam: `src/orchestrator/jev/plan-gate.ts` (`applyPlanGate`, `evaluatePlanWithGate`)
- Skill-pick seam: `src/orchestrator/jev/skill-pick-gate.ts` (`applySkillPick`, `evaluateSkillPickWithGate`)
- Flue port types: `src/adapters/flue/jev-lazy-load.ts`
- Port factory: `src/orchestrator/jev/skill-pick-port.ts` (`createJevSkillPickPort`)
- Log store: `src/orchestrator/jev/skill-pick-log.ts` (`createDrizzleSkillPickLogStore`)
- Hop-2 (unchanged fail-closed): `gateway/jev-router/systemone.ts`
