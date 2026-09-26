# Linear workflow

Product decision from 2026-09-26. This is the Kanban contract for Optio issues on Linear. It records who may move an issue, when, and what that move does on GitHub. It does not change the factory.

Phase 1 intake is already live and is the base this workflow extends. The status machine below is the contract for later status writes. The Phase 1 handler does not create pull requests and does not call `issueUpdate`.

Linear status names are not BullMQ stage names. The factory graph stays plan → implement → review → ready → merge ([pipeline.md](pipeline.md)).

## 1. Statuses

Six statuses carry in-flight work. **Done** is the finished state. **Canceled** and **Duplicate** are Linear system statuses that cannot be removed and are not part of the agent flow.

| Status | Board role | Meaning |
| --- | --- | --- |
| Triage | Active | The agent places an unclear or problematic issue here instead of guessing. This is not the waiting queue. |
| Backlog | Active | Queue of tasks that are waiting. |
| Todo | Active. Linear system status; cannot be deleted. | Start point. The agent picks the issue up from here. |
| In Progress | Active | Work is underway. Entering this status opens a **draft** pull request on GitHub. |
| Review | Active | Hard gate. Only the agent may move an issue here, and only when every CI check on the pull request is green. Entering this status marks the pull request ready for review (undraft). |
| Merge | Active | The agent merges that pull request into `main`. |
| Done | Finished | The task is finished. The Linear name is **Done**. **Completed** is an alias only when a board already uses that label. |
| Canceled | System. Cannot be removed. | Kept on the board. The agent flow does not enter or leave it. |
| Duplicate | System. Cannot be removed. | Same as Canceled. |

**Todo**, **Canceled**, and **Duplicate** stay because Linear will not delete them. The active path does not use **Canceled** or **Duplicate**.

## 2. Transitions

Humans may order **Triage**, **Backlog**, and **Todo**. From **In Progress** through **Merge**, the agent is the only actor that advances the issue. A human may read and approve the GitHub pull request while the issue sits in **Review**. A human may not drag the issue to **Review** to bypass CI.

| From | To | Actor | When | GitHub |
| --- | --- | --- | --- | --- |
| Backlog, Todo, or In Progress | Triage | Agent | The task is unclear or problematic. The agent does not guess a fix and does not force **Review**. | No new pull request. A draft that already exists stays a draft. No merge. |
| Triage | Backlog | Human | The task is clear enough to wait. | None. |
| Backlog | Todo | Human | The task is selected as the start point. | None. |
| Todo | In Progress | Agent | The agent starts the task. This is the start of agent ownership. | Open a draft pull request on the catalog repo for this issue. |
| In Progress | Review | Agent only | Every CI check on that pull request is green: tests, lint, and GitHub Actions. A red or pending check blocks the move. There is no manual override. | Mark the pull request ready for review (undraft). |
| Review | Merge | Agent | A human has read and approved the pull request. The agent performs the status move. | Merge the pull request into `main`. |
| Merge | Done | Agent | The merge has landed on `main`. | None. The pull request is already merged. |
| any | Canceled or Duplicate | — | Not a transition in this flow. | None. |

A human move into **Review** is not a pass. The integration must not treat it as the gate opening, and it must not undraft the pull request because of that move.

## 3. Hard gates

Two gates are fail-closed.

**In Progress → Review.** Only the agent may take this transition. It requires a green CI result on the pull request (tests, lint, Actions). No person, label, or comment overrides a red or pending check. The factory checks stay in force beside this board rule: `evaluateReviewGate` must pass before ready, and `evaluatePrSafetyGate` runs again inside `open_pr` and `merge_branch` ([review-gate.md](review-gate.md)). A Linear status does not soften those checks.

**Draft pull request → ready for review.** Undraft is a side effect of the agent moving the issue to **Review** after CI is green. It does not happen because a human edited the issue, and it does not happen while checks are red.

## 4. Agent ownership

The agent owns the chain from **In Progress** through **Merge**:

- **Todo → In Progress** starts the work and opens the draft pull request.
- **In Progress → Review** is the agent's move, and only after CI is green.
- **Review → Merge** is the agent's move after the human has approved the pull request.
- **Merge** is the agent merging that pull request into `main`, then moving the issue to **Done**.

Humans intervene at the review step itself: they read and approve the undrafted pull request. They do not force **Review** while CI is red, and they do not merge the pull request in place of the agent.

The orchestrator still has its own approval pause ([hitl.md](hitl.md)). This document does not retune that pause. See open questions.

## 5. What already exists

This workflow sits on the live edge and on Phase 1 intake. It does not replace them.

### Edge and intake

The live edge is `https://optio.eskobar.dev`. Linear calls `POST /webhooks/linear` on that host. The committed Caddyfile stays a hostname-free IP catch-all ([ops/caddy-tls-edge.md](ops/caddy-tls-edge.md)); the hostname is the operator front, not a secret in git.

Phase 1 (`src/orchestrator/intake/adapters/linear.ts`, [ops/intake-adapters.md](ops/intake-adapters.md), SPEC §8):

- The handler accepts `type: Issue`, `action: update`, when `updatedFrom` contains `stateId`, and the team key is `FIN` (`data.team.key`, or an identifier prefix `FIN-` when the team object is absent). Other events return `200` with `{ "accepted": false, "reason": "ignored" }` and do not enqueue.
- On accept it enqueues `bot.intake.created`. `repoId` is `OPTIO_NEW_LINEAR_DEFAULT_REPO_ID`. On kit-harness that value is `findjobabroad`. A blank value is `503` `linear_repo_unconfigured`. An id missing from the catalog is `400` `unknown_repo`. The workflow `repo_id` is not used for this route.
- Task id is `lin-<identifier>` (for example `lin-FIN-12`). One task id is one pipeline while that BullMQ job id remains. A retry whose job id already exists still comments and returns `200`. It does not start a second pipeline.
- After enqueue, the orchestrator calls Linear GraphQL `commentCreate` with body exactly `queued`.

Team **FIN** (“Find Job Abroad”) and team **Engineering** (**ENG**) may both exist. Phase 1 ignores any team other than `FIN`. **Engineering** is the intended Kanban for the statuses in this document once those columns exist on that board. Until the webhook accepts `ENG`, an Engineering status change does not enqueue.

### Write policy

`OPTIO_NEW_LINEAR_API_KEY` is limited by `src/orchestrator/linear/policy.ts`:

| Allowed | Rule |
| --- | --- |
| `commentCreate` | Live write. Phase 1 posts `queued`. |
| `issueUpdate` | May set `stateId` only. Reserved for the status moves in this document. The Phase 1 client does not call it. |

`issueCreate`, `issueDelete`, and `issueArchive` are rejected. Agent Sessions stay out of scope. The key must not gain create, delete, or archive in order to run this board.

### Observability

SigNoz is served at `https://optio.eskobar.dev/signoz/`. Intake and runs use the spans in [observability.md](observability.md): `enqueueIntakePipeline` emits `intake.webhook`, and `processStageJob` emits `workflow.step` for plan → implement → review → ready → merge. Export still follows `OPTIO_OTEL_SIGNOZ`. Do not put API keys, webhook secrets, or signature headers in span attributes or in this file.

### Catalog and pull requests

The multi-repo catalog holds `optio-new` and `findjobabroad` ([ops/multi-repo-cx33.md](ops/multi-repo-cx33.md)). `open_pr` resolves the task `repoId` to that binding and opens the GitHub pull request on the owner/repo parsed from the binding's `cloneUrl`. It does not fall back to `OPTIO_NEW_GITHUB_REPO` when `OPTIO_NEW_REPOS` is set. A FIN intake task therefore opens its pull request on `findjobabroad`. A task whose `repoId` is `optio-new` opens its pull request on that repo.

Today `open_pr` runs at the ready stage, after the review gate, and does not set `draft`. The base branch is the catalog binding's `defaultBranch`. The draft-on-**In Progress**, undraft-on-**Review**, and merge-into-`main` effects in the table above are the board contract. They are not what the Phase 1 webhook does.

## 6. Out of scope

- Implementing this file. No adapter, policy, or workflow change ships with it.
- Adding **Triage**, **Review**, and **Merge** on a board that still has Linear's classic six columns. Those columns are a later board edit.
- Teaching `POST /webhooks/linear` to accept team `ENG`.
- Calling `issueUpdate` from the Phase 1 path.
- Using these status names as BullMQ queues or as factory stage ids.
- Linear Agent Sessions, OAuth agent scopes, Agent Activities, backlog polling, and any create, delete, or archive of issues.
- Retuning the HITL pause, the review gate, or `open_pr`.

## 7. Open questions

- The board contract merges into `main`. `open_pr` and `merge_branch` still use the catalog `defaultBranch` (the synthetic catalog default is `development` via `OPTIO_NEW_BASE_BRANCH`). Pointing the Linear merge at `main` is a later change.
- A later `issueUpdate` of `stateId` on a FIN issue will hit the Phase 1 webhook again. That delivery must keep the existing task id and must not start a second pipeline. The `queued` comment on a reused job id is the current ack.
- [hitl.md](hitl.md) still pauses `ready` before `open_pr` (default `always`). This board treats human approval as a review of the GitHub pull request. Wiring or skipping that pause for Linear-sourced tasks is undecided.

## Related

- [ops/intake-adapters.md](ops/intake-adapters.md) — Phase 1 `POST /webhooks/linear`
- [SPEC.md](SPEC.md) §8 — intake ADR
- [review-gate.md](review-gate.md) — CI and PR safety gates
- [pipeline.md](pipeline.md) — BullMQ stages, including `open_pr`
- [hitl.md](hitl.md) — orchestrator approval pause
- [observability.md](observability.md) — OTEL spans
- [ops/multi-repo-cx33.md](ops/multi-repo-cx33.md) — catalog `repoId`
