# Linear workflow

Product decision from 2026-09-26. This is the Kanban contract for Optio issues on Linear. It records who may move an issue, when, and what that move does on GitHub.

Phase 1 intake is the base. It still enqueues `bot.intake.created` and comments `queued`, and it does not itself open a pull request. Status writes and GitHub draft, undraft, and merge run in `src/orchestrator/linear/` for tasks whose intake `source` is `linear`.

Linear status names are not BullMQ stage names. The factory graph stays plan → implement → review → ready → merge ([pipeline.md](pipeline.md)).

## 1. Statuses

Six statuses carry in-flight work. **Done** is the finished state. **Canceled** and **Duplicate** are Linear system statuses that cannot be removed and are not part of the agent flow.

| Status      | Board role                                       | Meaning                                                                                                                                                                                                                                          |
| ----------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Triage      | Active                                           | The agent places an unclear or problematic issue here instead of guessing. This is not the waiting queue.                                                                                                                                        |
| Backlog     | Active                                           | Queue of tasks that are waiting.                                                                                                                                                                                                                 |
| Todo        | Active. Linear system status; cannot be deleted. | Start point. The agent picks the issue up from here.                                                                                                                                                                                             |
| In Progress | Active                                           | Work is underway. The first entry from **Todo** opens a **draft** pull request. A return from **Review** keeps that pull request ready for review.                                                                                               |
| Review      | Active                                           | Hard gate. Only the agent may move an issue here, and only when every CI check on the pull request is green. Entering this status undrafts the pull request, requests the configured GitHub reviewers, and dispatches the review agent (Hannes). |
| Merge       | Active                                           | The agent merges that pull request into `main`.                                                                                                                                                                                                  |
| Done        | Finished                                         | The task is finished. The Linear name is **Done**. **Completed** is an alias only when a board already uses that label.                                                                                                                          |
| Canceled    | System. Cannot be removed.                       | Kept on the board. The agent flow does not enter or leave it.                                                                                                                                                                                    |
| Duplicate   | System. Cannot be removed.                       | Same as Canceled.                                                                                                                                                                                                                                |

**Todo**, **Canceled**, and **Duplicate** stay because Linear will not delete them. The active path does not use **Canceled** or **Duplicate**.

## 2. Transitions

Humans may order **Triage**, **Backlog**, and **Todo**. From **In Progress** through **Merge**, the agent is the only actor that advances the issue. A human may read and approve the GitHub pull request while the issue sits in **Review**. A human may not drag the issue to **Review** to bypass CI.

| From                          | To                    | Actor      | When                                                                                                                                                                                                                   | GitHub                                                                                                                                                                    |
| ----------------------------- | --------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backlog, Todo, or In Progress | Triage                | Agent      | The task is unclear or problematic. The agent does not guess a fix and does not force **Review**.                                                                                                                      | No new pull request. A draft that already exists stays a draft. No merge.                                                                                                 |
| Triage                        | Backlog               | Human      | The task is clear enough to wait.                                                                                                                                                                                      | None.                                                                                                                                                                     |
| Backlog                       | Todo                  | Human      | The task is selected as the start point.                                                                                                                                                                               | None.                                                                                                                                                                     |
| Todo                          | In Progress           | Agent      | The agent starts the task. This is the start of agent ownership.                                                                                                                                                       | Open a draft pull request on the catalog repo for this issue.                                                                                                             |
| In Progress                   | Review                | Agent only | Every CI check on that pull request is green (tests, lint, and GitHub Actions) and no review feedback is still open. A red or pending check blocks the move. There is no manual override.                              | Undraft with `markPullRequestReadyForReview` (idempotent when already ready), request `OPTIO_REVIEW_GITHUB_LOGINS`, and dispatch Hannes. A human drag does none of these. |
| Review                        | In Progress           | Agent      | CI is red, or a review requests changes or leaves feedback, and the attempt count is still under the threshold. A pending check waits and does not count. The same commit with the same feedback does not count twice. | Keep the pull request ready for review. Re-request review and comment with the feedback. Do not convert it back to a draft.                                               |
| Review                        | Merge                 | Agent      | CI is green, review feedback is clear, and a human has approved the pull request. The agent performs the status move.                                                                                                  | Merge the pull request into `main`.                                                                                                                                       |
| Merge                         | Done                  | Agent      | The merge has landed on `main`.                                                                                                                                                                                        | None. The pull request is already merged.                                                                                                                                 |
| In Progress or Review         | Needs Human           | Agent      | Escape hatch. Failed return trips have reached `LINEAR_WORKFLOW_CI_FAIL_ESCALATE_AFTER` (default 3), or the agent is in a blind alley. Preferred target when that column exists.                                       | Do not merge. This move does not undraft, does not convert a ready pull request back to a draft, and does not count as entering **Review**.                               |
| In Progress or Review         | In Progress           | Agent      | Same escape hatch, while the board has no **Needs Human** column. If the issue is already **In Progress**, the status stays put.                                                                                       | Same. The Linear comment is the signal.                                                                                                                                   |
| any                           | Canceled or Duplicate | —          | Not a transition in this flow.                                                                                                                                                                                         | None.                                                                                                                                                                     |

A human move into **Review** is not a pass. The integration must not treat it as the gate opening. It must not undraft the pull request, request reviewers, or dispatch Hannes because of that move.

## 3. Hard gates

Two gates are fail-closed.

**In Progress → Review.** Only the agent may take this transition. It requires a green CI result on the pull request (tests, lint, Actions) and no open review feedback. No person, label, or comment overrides a red or pending check. The factory checks stay in force beside this board rule: `evaluateReviewGate` must pass before ready, and `evaluatePrSafetyGate` runs again inside `open_pr` and `merge_branch` ([review-gate.md](review-gate.md)). A Linear status does not soften those checks.

**Draft pull request → ready for review.** Undraft is a side effect of the agent moving the issue to **Review** after CI is green and review feedback is clear. It does not happen because a human edited the issue, and it does not happen while checks are red. The call is the GraphQL mutation `markPullRequestReadyForReview`. REST `PATCH` with `draft: false` does not undraft: GitHub ignores that field and still returns 200, which left the pull request a draft after Linear was already **Review**.

A red check or open review feedback does not open the gate. The agent moves the issue back to **In Progress** with concrete feedback and increments the attempt counter. The pull request stays ready for review for the rest of that loop: the return does not set `draft: true`. See [Review ↔ In Progress](#review--in-progress).

### Review entry (Hannes)

**Hannes** is not a GitHub login and not a Linear user in this repository. It is the review automation that runs when the agent enters **Review**.

The Eve slot `agents/review` still runs earlier, after implement and before ready (`invoke_review`, skill `skills/code-review`). That slot is a local gate. It does not undraft, does not request reviewers, and does not post on the pull request.

Review entry is the same decision that sets **Review** after green CI (`decideAgentAdvance` when the action is `review`, and the green `merge` wait that is still awaiting a GitHub approval). It does not run when CI is red or pending. It does not run when a human drags the issue to **Review**. The webhook still reverts that drag and does not touch GitHub. Linear moving to **Review** is not a way to skip CI.

Effects, in order, before the status write:

1. `github.ready` undrafts. The implementation reads the pull request and returns when `draft` is already false. Otherwise it runs `markPullRequestReadyForReview` with the pull request node id. A result that is still a draft fails the step, so Linear is not moved to **Review** on a failed undraft.
2. `github.request_reviewers` calls `POST /pulls/{n}/requested_reviewers` for the logins in `OPTIO_REVIEW_GITHUB_LOGINS` (comma-separated). Unset or blank requests nobody. A 422, for example when the login is the author, does not fail the step. There is no default login and no secret in git.
3. `github.dispatch_review` stops when an issue comment for this head SHA already contains `<!-- optio-review sha:<sha> -->`. Otherwise it runs the review coding agent, read-only, on Standards, Spec, and Slop (`skills/code-review`). The prompt also names the specialists whose paths are in the diff: `specialists/back-end`, `specialists/database`, `specialists/devops`, and `specialists/front-end`. The result is a pull request issue comment, not a review event, so it does not count as open review feedback. The BullMQ stage `optio.review` is not enqueued again.

That comment is not a human approval. Merge still waits for an `APPROVED` review and the merge approval gate.

Choice: always undraft and request reviewers at Review entry, and post one Hannes comment per head SHA when it is missing. The earlier Eve review is not replayed as a second pipeline stage, because that stage already finished and its output never reached GitHub.

ENG-7 on findjobabroad pull request 69 is the observed case: Linear is **Review**, the pull request is still `draft: true`, and `requested_reviewers` is empty. A deploy does not replay a ready stage that already completed. The first live check is to run `record_ci_wait` again for `lin-ENG-7` while CI on that head is still green and the worktree pull record still points at pull request 69. Do not drag the Linear issue by hand.

A red check does not let a human force **Review**. When the failed returns reach the threshold, or the agent is in a blind alley, the autonomous path stops on the exception in [Human-assistance escape hatches](#5-human-assistance-escape-hatches).

## 4. Agent ownership

The agent owns the chain from **In Progress** through **Merge**:

- **Todo → In Progress** starts the work and opens the draft pull request.
- **In Progress → Review** is the agent's move, and only after CI is green and review feedback is clear.
- **Review → In Progress** is the agent's move when CI is red or review feedback is still open, while attempts remain under the threshold.
- **Review → Merge** is the agent's move after CI is green, review feedback is clear, and the human has approved the pull request.
- **Merge** is the agent merging that pull request into `main`, then moving the issue to **Done**.

Humans intervene at the review step itself: they read and approve the undrafted pull request. They do not force **Review** while CI is red, and they do not merge the pull request in place of the agent.

That autonomy is the default from **In Progress** through **Merge**, not an absolute. The only required stops for human help are the two escape hatches in [Human-assistance escape hatches](#5-human-assistance-escape-hatches).

The orchestrator merge approval ([hitl.md](hitl.md)) is the human gate immediately before `merge_branch`. It does not pause `ready`, so `record_ci_wait` can move the issue when CI is green. Plan approval is unchanged: it still pauses at the start of `implement` when planner confidence is low.

Linear order:

1. `record_diff` opens a draft pull request and sets **In Progress**.
2. `ready` runs `open_pr` (reuses that draft) and `record_ci_wait` with no merge approval.
3. Green CI and clear review feedback in `record_ci_wait` set **Review**, undraft the pull request, request reviewers, dispatch Hannes, and post `[status]` (trigger `ci`) and `[ci]` (result green).
4. The merge gate then pauses until a person approves.
5. `merge_branch` merges only after that approval, and only when CI is still green and a GitHub review is approved.

## 5. Human-assistance escape hatches

Default: the agent runs from **In Progress** through **Merge** without asking for help. A human still reads and approves the pull request at **Review**. Under the threshold below, a problem found at **Review** loops the issue back to **In Progress** with feedback. The hatches are the stop. They are rare. The agent must take one when the threshold is reached or the work is a blind alley, and must not keep looping after that.

### Review ↔ In Progress

While the attempt count is under the threshold, a problem found at **Review** sends the issue back to **In Progress**. A problem is CI red (tests, lint, or Actions), or review feedback: the latest review from a person requests changes, or leaves a comment with a body. A later approval from that person clears their feedback. A pending check is not a failure and does not move the issue. The same commit with the same feedback is one failure; a retry of that evaluation does not increment the count and does not post the comment again. The agent may still attempt the fix on that retry.

The return posts a Linear `[review]` comment the agent consumes. The same text is the GitHub review comment and the pull request comment:

```text
[review]
Failed: <what failed>
Must fix: <what must be fixed>
Attempt: <n>/<threshold>
```

The same text is written to `linear-review-feedback.md` in the worktree. The implementation agent attempts one fix from that file and commits it. The orchestrator pushes the branch when the commit changed. It does not open a new pull request and it does not set `draft: true`.

The pull request stays ready for review. The orchestrator re-requests the reviewers already on the pull request (`POST /pulls/{n}/requested_reviewers`) and posts the same feedback as a pull request comment. That resets review state so reviewers see the new changes. A 422 from the re-request (for example the author cannot be requested) still leaves the comment in place.

The next evaluation runs on the new CI result. Green CI and no open review feedback moves the issue back to **Review**. Undraft runs again and is a no-op when the pull request is already ready. That pass resets the attempt count to 0, and the flow continues toward **Merge**. Red CI or new review feedback increments the count. The third failed return, at the default threshold, escalates.

### Repeated Review / CI failure

Escalate when the failed returns above have reached the threshold.

One failure is one failed return trip: an attempt to enter or stay in **Review** whose CI is red, or whose review feedback is still open. A pending check is not a failure. The count is per task.

The threshold is configurable. The knob is `LINEAR_WORKFLOW_CI_FAIL_ESCALATE_AFTER`. Unset, blank, or a value that is not a positive integer uses **3**. A default of 5 was considered; **3** is the chosen default. The third failed return escalates. The orchestrator reads the knob when a Linear-sourced task evaluates the gate. The count and the last failure key are stored beside the worktree (`.prs/<task>.linear.json`, fields `ciFailureCount` and `lastFailureKey`). A green return to **Review** resets the count to 0.

### Blind alley

Escalate when the agent cannot productively continue: another attempt would not move the solution forward. Do not spend the remaining CI attempts to postpone that judgment. This hatch does not wait for the count above.

The implementation and review agents signal it with one line in their output:

```text
LINEAR_BLIND_ALLEY why: <why> | tried: <what was tried> | failed: <what failed>
```

`readBlindAlley` accepts that line from the coding-agent logs or diff summary. The stage then escalates and stops. A partial line is ignored.

### What escalation does

On either hatch the agent stops the autonomous chain. It does not take another **In Progress → Review** attempt, and it does not merge, until a human has acted.

It leaves three traces:

- **When and why.** Name the hatch, the moment it tripped, and a short rationale. For the CI hatch, include the failure count and the configured threshold.
- **What was tried, and what failed.** Enough for a person to continue. Not a dump of logs or secrets.
- **What the human should do next.** A `Next:` line on the `[escalate]` comment. For a CI hatch, fix the failure and move the issue back to **In Progress** when the agent should resume. For a blind alley, choose a different approach.
- **Where the issue sits.** Move it to **Needs Human** when that column exists. That is the preferred target. Until the column exists, move it back to **In Progress** (leave it there if it never left). **Needs Human** is not one of the six in-flight statuses until the board has the column.

Post that context as a Linear `commentCreate` whose first line is `[escalate] Human help needed`. A `[status]` comment records the move. The body is this rationale, not the Phase 1 ack `queued`. The status move is `issueUpdate` of `stateId` only. `applyWorkflowEffects` resolves **Needs Human** from the issue's team states and falls back to **In Progress** when that name is missing. The code does not create the column (`boardSetupPlan().createColumns` is false). The pull request stays unmerged. Escalation does not undraft it and does not open the **Review** gate.

The rest of the flow stays autonomous. Outside these hatches, humans still intervene only by reading and approving the pull request at **Review**.

## 6. Issue history

Opening the Linear issue is enough to read the run. GitHub still holds the pull request, the checks, and the review thread. The issue comment list is the copy a person can read without leaving Linear.

Phase 1 still posts exactly `queued` after intake. Every later workflow comment is a short structured note. The first line is one of `[status]`, `[ci]`, `[review]`, or `[escalate]`.

| Prefix       | When it is posted                                                                                                                                                         | What it contains                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `[status]`   | Every status move the agent or the webhook gate writes, including a human move into **Review**, **Merge**, or **Done** that is reverted.                                  | `Status`, `Trigger` (`agent`, `ci`, `human`, or `review`), and a one-line `Rationale`.                   |
| `[ci]`       | Once when a commit's checks start, and once for each distinct result on that commit (`pending`, `green`, or `red`). A retry of the same commit and the same result waits. | `Phase: started` or `Result`, the failed check names when the result is red, and `Attempt: n/threshold`. |
| `[review]`   | A failed return to **In Progress**, whether CI is red or a reviewer left feedback.                                                                                        | `Failed`, `Must fix`, and `Attempt`. The implementation agent reads this same text.                      |
| `[escalate]` | The attempt threshold or a blind alley stops the autonomous chain.                                                                                                        | `When`, `Why`, `Tried`, `Failed`, and `Next`.                                                            |

A red result with no named GitHub status contexts or check runs says `Failed checks: combined status`. Named status contexts (for example `ci/lint`) and failed check run names are listed when the payload includes them.

The `[review]` text is also posted on the GitHub pull request: a review with event `COMMENT`, then an issue comment with the same body. Reviewers are re-requested in the same step. None of those calls set `draft`.

## 7. What already exists

This workflow sits on the live edge and on Phase 1 intake. It does not replace them.

### Edge and intake

The live edge is `https://optio.eskobar.dev`. Linear calls `POST /webhooks/linear` on that host. The committed Caddyfile stays a hostname-free IP catch-all ([ops/caddy-tls-edge.md](ops/caddy-tls-edge.md)); the hostname is the operator front, not a secret in git.

Phase 1 (`src/orchestrator/intake/adapters/linear.ts`, [ops/intake-adapters.md](ops/intake-adapters.md), SPEC §8):

- The handler accepts `type: Issue`, `action: update`, when `updatedFrom` contains `stateId`, and the team key is enabled in `config/linear-projects.yaml` (`data.team.key`, or an identifier prefix such as `ENG-` when the team object is absent). Disabled and unknown teams return `200` with `{ "accepted": false, "reason": "ignored" }` and do not enqueue. A missing or invalid file returns `503` `linear_projects_unconfigured`.
- On accept it enqueues `bot.intake.created`. `repoId` is `OPTIO_NEW_LINEAR_DEFAULT_REPO_ID` when that env is set; otherwise the team's `defaultRepoId`. ENG defaults to `findjobabroad`. Both blank is `503` `linear_repo_unconfigured`. An id missing from the catalog is `400` `unknown_repo`. The workflow `repo_id` is not used for this route.
- Task id is `lin-<identifier>` (for example `lin-ENG-12`). One task id is one pipeline while that BullMQ job id remains. A retry whose job id already exists still comments and returns `200`. It does not start a second pipeline.
- After enqueue, the orchestrator calls Linear GraphQL `commentCreate` with body exactly `queued`.

The seeded allowlist enables **ENG** (Engineering). **FIN** stays in the file with `enabled: false`. Add another team by copying an entry. `webhookPath` does not change the mount, which stays `POST /webhooks/linear`. **Engineering** is the Kanban for the statuses in this document.

### Write policy

`OPTIO_NEW_LINEAR_API_KEY` is limited by `src/orchestrator/linear/policy.ts`:

| Allowed         | Rule                                                                                                           |
| --------------- | -------------------------------------------------------------------------------------------------------------- |
| `commentCreate` | Live write. Phase 1 posts `queued`. Later workflow notes use `[status]`, `[ci]`, `[review]`, and `[escalate]`. |
| `issueUpdate`   | May set `stateId` only. The workflow module calls it for status moves. The Phase 1 ack does not.               |

`issueCreate`, `issueDelete`, and `issueArchive` are rejected. Agent Sessions stay out of scope. The key must not gain create, delete, or archive in order to run this board.

### Observability

SigNoz is served at `https://optio.eskobar.dev/signoz/`. Intake and runs use the spans in [observability.md](observability.md): `enqueueIntakePipeline` emits `intake.webhook`, and `processStageJob` emits `workflow.step` for plan → implement → review → ready → merge. A Linear transition also emits `gate.pass` or `gate.fail` with `gate=linear.workflow` and `reason`. Export still follows `OPTIO_OTEL_SIGNOZ`. Do not put API keys, webhook secrets, or signature headers in span attributes or in this file.

### Catalog and pull requests

The multi-repo catalog holds `optio-new` and `findjobabroad` ([ops/multi-repo-cx33.md](ops/multi-repo-cx33.md)). `open_pr` resolves the task `repoId` to that binding and opens the GitHub pull request on the owner/repo parsed from the binding's `cloneUrl`. It does not fall back to `OPTIO_NEW_GITHUB_REPO` when `OPTIO_NEW_REPOS` is set. A FIN intake task therefore opens its pull request on `findjobabroad`. A task whose `repoId` is `optio-new` opens its pull request on that repo.

For a task whose intake `source` is `linear`, the production handler drives the board:

- `record_diff` opens a **draft** pull request on the catalog repo for that `repoId`, with base `main`, then sets **In Progress** and posts a `[status]` comment (trigger `agent`).
- `record_ci_wait` posts `[ci] Phase: started` once per commit, then a `[ci]` result. It moves to **Review** only when commit statuses and Actions workflow runs for the head SHA are `success` and review feedback is clear, with a `[status]` comment (trigger `ci`). That same decision undrafts, requests `OPTIO_REVIEW_GITHUB_LOGINS`, and dispatches Hannes (see [Review entry (Hannes)](#review-entry-hannes)). A green workflow run counts as success when the commit status list has no contexts, so an Actions-only repository does not need a synthetic `optio/ci` status or the Checks permission. A fine-grained PAT 403 on commit statuses or check runs is ignored. `neutral` and `skipped` conclusions do not fail the wait. `cancelled` does. Pending only while a status or workflow run is still in progress. A red status or workflow run, or a review that requests changes or comments, moves the issue back to **In Progress** with `[status]`, `[review]`, and `[ci]` comments, re-requests review, posts that `[review]` text on the pull request, and asks the implementation agent to fix `linear-review-feedback.md`. That return keeps the pull request ready (`draft` stays false) and does not dispatch Hannes again. Pending does not count. The same commit and the same feedback do not count twice, and the same CI result is not commented twice. The third failed return escalates with `[escalate]`. The webhook does not undraft, request reviewers, or dispatch Hannes.
- `merge_branch` uses the same return when CI is red or review feedback is still open. When CI is green, feedback is clear, and a GitHub review is `APPROVED`, it merges that pull request, then sets **Merge** and **Done** (or **Completed** when that is the only finished name on the team). Green without a GitHub approval waits, sets **Review** again, and runs the same undraft, reviewer request, and Hannes dispatch. The dispatch posts nothing new when this head already has an `[optio-review]` comment.
- A human move into **Review**, **Merge**, or **Done** is reverted to `updatedFrom.stateId` after the Phase 1 `queued` comment, and a `[status]` comment records that revert (trigger `human`). The agent's own `issueUpdate` is marked for 60 seconds so that webhook does not revert it.

`open_pr` still runs at ready for every task. On a Linear task it reuses the draft already opened and does not undraft it. Other intake sources keep the catalog `defaultBranch` and a non-draft pull request. Phase 1 intake does not itself open or merge a pull request.

Merge approval does not sit in front of `record_ci_wait`. The pause is the start of `merge`, before `merge_branch`, after a green result has already set **Review**.

## 8. Out of scope

- Creating or renaming Linear columns. The board must already contain the names this workflow sets. **Needs Human** is optional; escalation falls back to **In Progress**.
- Adding **Triage**, **Review**, and **Merge** on a board that still has Linear's classic six columns. Those columns are a later board edit.
- Teaching `POST /webhooks/linear` to accept team `ENG`.
- Calling `issueUpdate` from the Phase 1 ack. That path still posts only `queued`. Status writes belong to the workflow module.
- Using these status names as BullMQ queues or as factory stage ids.
- Linear Agent Sessions, OAuth agent scopes, Agent Activities, backlog polling, and any create, delete, or archive of issues.
- Retuning the review gate or `open_pr`. Merge approval stays before `merge_branch` ([hitl.md](hitl.md)).

## 9. Open questions

- Linear-sourced pull requests use base `main`. Other sources still use the catalog `defaultBranch`. A task branch that was not cut from `main` can fail the draft open.
- A later `issueUpdate` of `stateId` on a FIN issue will hit the Phase 1 webhook again. That delivery must keep the existing task id and must not start a second pipeline. The `queued` comment on a reused job id is the current ack.

## Related

- [ops/intake-adapters.md](ops/intake-adapters.md) — Phase 1 `POST /webhooks/linear`
- [SPEC.md](SPEC.md) §8 — intake ADR
- [review-gate.md](review-gate.md) — CI and PR safety gates
- [pipeline.md](pipeline.md) — BullMQ stages, including `open_pr`
- [hitl.md](hitl.md) — orchestrator approval pause
- [observability.md](observability.md) — OTEL spans
- [ops/multi-repo-cx33.md](ops/multi-repo-cx33.md) — catalog `repoId`
