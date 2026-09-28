# Jev gate sequence (ENG-25)

Ordered soft-decision gates for the Optio factory. **Jev lives in Optio only** — never as the Cursor session LLM. Wire protocol: `POST /v1/systemone`, pinned model **`jev-1.13.0`**.

Shared client: `createJevClient` in `gateway/jev-router/jev-client.ts` (inject `fetch`, AbortSignal timeout). Soft gates **timeout → passthrough**. Hard policy stays deterministic code.

DB attachment: `optio.stage_jev_gates.gate_kind` (`jev_gate_kind` enum from ENG-24).

## Ordered rollout

| #   | `gate_kind`        | Purpose                                                    | Labels / outcome                                                        | Status                                            |
| --- | ------------------ | ---------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------- |
| 1   | `backend_cascade`  | Backend / model cascade per issue complexity               | `flue_cheap` \| `cursor_composer` \| `cursor_frontier` \| `needs_human` | **Implemented** (this PR)                         |
| 2   | `plan`             | Plan / spec quality; auto-clear high-confidence safe plans | `auto_clear` \| `needs_revision` \| `needs_human`                       | Stub types only                                   |
| 3   | `skill_pick`       | Which skills / MCP tools to inject before spawn            | `skill_ids[]` + confidence                                              | Stub types only — **dynamic later, no allow-all** |
| 4   | `review_prescreen` | Filter diffs before human review (Hannes)                  | `forward` \| `filter` \| `needs_human`                                  | Stub types only                                   |
| 5   | `intake`           | Classify Linear / intake issues                            | `enqueue` \| `clarify` \| `reject` \| `needs_human`                     | Stub types only                                   |

## Shared mechanics

| Knob                      | Default           | Notes                                       |
| ------------------------- | ----------------- | ------------------------------------------- |
| Model                     | `jev-1.13.0`      | `PINNED_JEV_MODEL`                          |
| `timeoutMs`               | `30000`           | Matches `stage_jev_gates.timeout_ms`        |
| `passthroughOnTimeout`    | `true`            | Soft gates fail open                        |
| `minConfidence` (cascade) | `0.7`             | Below threshold → passthrough               |
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

## Gates #2–5 (documented stubs)

Zod answer shapes live in `gateway/jev-router/gates/types.ts` (`PlanGateAnswerSchema`, `SkillPickGateAnswerSchema`, `ReviewPrescreenAnswerSchema`, `IntakeTriageAnswerSchema`). No runners in this PR.

**Skill pick (#3):** Jev must observe the **full skill registry** per agent/specialist and select **per-task**. Do not hardcode an allow-all list. Log every choice (task type, selected skills, outcome) for the self-improvement loop (`optio.skill_pick_logs`).

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
- Hop-1 helper: `src/adapters/select.ts` (`applyBackendCascade`)
- Hop-2 (unchanged fail-closed): `gateway/jev-router/systemone.ts`
