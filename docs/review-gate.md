# Review gate before ready

The BullMQ `ready` stage starts only after `evaluateReviewGate` (`src/orchestrator/jobs/review-gate.ts`) returns `pass`. SPEC §3 and §9: deterministic rules decide; Jev may only soften a pass into rework or replan. Jev is not asked when a hard check already failed.

`kit-harness` `checkCompletion` is not on `main`. This module is the local gate. A future sidecar can be injected as `CompletionAdvisor` (`kind: "completion"`) without changing the path table.

## Evidence

The gate fails closed. A missing evidence object, a missing `tests_green`, or a missing `ci_status` is `evidence_incomplete`. It is not treated as green.

Pass requires all of:

- `tests_green === true`
- `ci_status === "success"`
- no open blockers
- rules completion pass, unless a confident Jev advisor (confidence ≥ 0.8) says `retry` or `fail`

`ci_status` of `pending` is `ci_pending`. `failure` and `missing` are `ci_failed`.

## Paths

Default attempt budget is 3 (`attempt` / `max_attempts` on the evidence).

| Verdict | When                                    | Path     | Next stage                               |
| ------- | --------------------------------------- | -------- | ---------------------------------------- |
| `retry` | Check failed and attempts remain        | `rework` | implementation, with `review_notes`      |
| `fail`  | Attempt budget exhausted                | `replan` | planner                                  |
| `fail`  | Open blockers (immediate, hard)         | `replan` | planner                                  |
| `fail`  | Confident Jev `fail` after rules passed | `replan` | planner                                  |
| `pass`  | Tests green, CI green, completion pass  | `ready`  | ready (`open_pr`, then `record_ci_wait`) |

A closed gate throws `ReviewGateClosedError` (BullMQ `UnrecoverableError`). The ready cursor is not written, and the ready job is not retried in place. The orchestrator follows `decision.path` instead.

Workers that omit `StageRuntime.reviewGate` keep the skeleton graph. Production ready workers must set the binding so a run without evidence cannot enter ready.
