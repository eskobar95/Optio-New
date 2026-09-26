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

## PR safety gate

`createProductionStageHandler` runs `evaluatePrSafetyGate` (`src/orchestrator/jobs/pr-safety-gate.ts`) inside `open_pr` and again inside `merge_branch`, after implement and review have finished and before any push or merge. This is the `pr_safety` entry on the ready and merge steps in `workflows/default-task.yaml`.

The gate fails closed:

| Result                                       | Reason                                               |
| -------------------------------------------- | ---------------------------------------------------- |
| Test, lint, or typecheck command did not run | `tests_not_run`, `lint_not_run`, `typecheck_not_run` |
| One of those commands exited non-zero        | `tests_failed`, `lint_failed`, `typecheck_failed`    |
| No pnpm, npm, or shrinkwrap lockfile         | `lockfile_missing`                                   |
| Dependency install failed or did not run     | `deps_install_failed`                                |
| Diff could not be read                       | `diff_not_reviewed`                                  |
| Added secret file or secret material         | `secret_in_diff`                                     |
| Destructive command or an unsafe path        | `destructive_path`                                   |

A closed gate throws `PrSafetyClosedError` (BullMQ `UnrecoverableError`). The message is `pr safety gate closed: <reason> <path> (<rule>)`. The path and rule are included. Secret bytes and command output are not. Nothing is pushed and the pull request is not merged.

The default collector reads the worktree diff first (`git diff <base>...HEAD`, unstaged changes, and untracked files). A secret, a destructive change, or an unreadable diff skips install and the quality checks, so those commands are not executed against an unreviewed tree. When the diff is clean, the lockfile selects the package manager. `pnpm-lock.yaml` installs with `pnpm install --frozen-lockfile --ignore-scripts` and runs `pnpm run test`, `pnpm run lint`, and `pnpm run typecheck`. `package-lock.json` or `npm-shrinkwrap.json` keeps `npm ci --ignore-scripts --include=dev`, then `npm test`, `npm run lint`, and `npm run typecheck`. `pnpm-lock.yaml` wins when both are present. No recognized lockfile fails as `lockfile_missing` and does not fall through to npm. A non-zero install, or an install that does not run, fails as `deps_install_failed` and does not run the quality checks. When the install succeeds, those three commands must exit 0. `<base>` is `OPTIO_NEW_BASE_BRANCH` or `development`. Sparse-excluded `.cursor/{skills,agents,commands,rules}` are symlinked from `OPTIO_NEW_REPO_PATH` before checks. When `node_modules/vitest` is missing (typical for a bind-mounted host checkout worktree), the gate installs with the detected package manager before the checks. npm and pnpm runs set `NODE_ENV=test` and strip live `OPTIO_NEW_REDIS_URL` / `OPTIO_NEW_DATABASE_URL` and tokens so optional integration tests stay skipped inside the orchestrator container. An unsafe base ref is not passed to git.

Host proof, without opening a pull request:

```bash
bash scripts/pr-safety-gate-proof.sh
```
