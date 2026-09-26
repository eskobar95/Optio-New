# Review gate before ready

The BullMQ `ready` stage starts only after `evaluateReviewGate` (`src/orchestrator/jobs/review-gate.ts`) returns `pass`. The verdict comes from kit-harness `checkCompletion` (`POST /v1/completion-check` uses the same function). SPEC §3 and §9: deterministic rules decide; Jev may only soften a pass into rework or replan. Jev is not asked when a hard check already failed.

The review gate maps that verdict onto the pipeline. It does not reimplement the checks. A sidecar is a `DecisionAdvisor` with `kind: "completion"`.

## Evidence

The gate fails closed. A missing evidence object or a missing `tests_green` is `evidence_incomplete`. An omitted `ci_status` is passed to the harness as `missing`, which is `ci_failed`. Neither is treated as green.

Pass requires `checkCompletion` to return `pass`, which includes:

- `tests_green === true`
- `ci_status === "success"`
- no open blockers
- typecheck, lint, and diff not explicitly failed
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
