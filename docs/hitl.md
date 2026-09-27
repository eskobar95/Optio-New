# Human-in-the-loop approval

Plan and merge can wait for an explicit approve, reject, or replan. The orchestrator records that decision and wakes the BullMQ job. A required gate does not approve itself.

## Pause points

| Point   | When it runs                            | Default mode          |
| ------- | --------------------------------------- | --------------------- |
| `plan`  | Start of `implement`, after plan        | `when_confidence_low` |
| `merge` | Start of `merge`, before `merge_branch` | `always`              |

`ready` (`open_pr`, then `record_ci_wait`) does not open the merge gate. A Linear-sourced task can move to **Review** when CI is green, undraft the pull request, request the configured reviewers, and dispatch Hannes before merge. Plan approval is unchanged. Starting that review is not a human step.

When Hannes emits `OPTIO_REVIEW_VERDICT pass` and CI is still green, the ready step writes a merge approval with `source: policy` and `reason: review_agent_approved`. The merge pause then continues. `merge_branch` first updates the task branch when it is behind the pull request base, without a force-push. Land runs only through `landAtMergeGate`: the tree is clean, CI must be green on that head, and the stored verdict for that head must be pass (or a GitHub review must be `APPROVED`). A missing verdict does not merge. A red or pending check does not merge. An unresolved conflict returns the issue to **In Progress**. A rejected merge row stays rejected.

Order for a Linear task on the happy path: draft pull request and **In Progress** → CI wait → **Review** on green → Hannes pass → merge and **Done**, with no person in that chain. A Hannes fail returns the issue to **In Progress** and does not approve merge. While CI on the new head is pending, the ready job is delayed and `record_ci_wait` runs again. Hannes is dispatched only after that head is green.

A merge row that is already `pending` does not block `ready`. The next delivery of a delayed `ready` job runs `open_pr` and `record_ci_wait`. The merge job then pauses on that same decision before `merge_branch`.

`when_confidence_low` pauses unless planner confidence is a finite number in `[0, 1]` and at least the threshold (default **0.8**). A missing confidence pauses. `always` pauses even when confidence is 1. `off` does not pause.

A high-confidence continue writes an approval row with `source: policy` and `reason: confidence_at_or_above_threshold`, and logs `msg: hitl`. That path is only taken when the mode allows it.

## Actions

`POST /approvals` on the orchestrator (port 3100):

```json
{ "taskId": "t-1", "sessionId": "s-1", "point": "plan", "action": "approve" }
```

`point` is `plan` or `merge`. `action` is `approve`, `reject`, or `replan`. `sessionId` defaults to `taskId`.

| Action    | Effect                                                                                   |
| --------- | ---------------------------------------------------------------------------------------- |
| `approve` | Marks the row approved and promotes the paused stage job (`implement` or `merge`).       |
| `reject`  | Marks the row rejected. The stage fails closed. The worktree is not reaped.              |
| `replan`  | Marks the row replan, resets the plan cursor to pending, and queues plan again. No reap. |

`GET /approvals?taskId=&sessionId=` returns the rows (`status`, `reason`, `source`, `confidence`, `timeoutAt`). There is no token or key in that body.

A decision is accepted only while `status` is `pending` or `timed_out`. Anything else returns `409` with `error: not_awaiting`.

While the gate is pending, the BullMQ worker moves the job to delayed (`DelayedError`) and checks again after `poll_ms` (default 60 seconds). The stage cursor stays unfinished, so later stages do not run.

## Timeout

`timeout_ms` defaults to 24 hours (`86400000`), from the moment the gate opens.

When that time has passed, the next check sets `status: timed_out`, `reason: timeout_no_auto_approve`, and emits one notify event `kind: timeout`. The stage stays paused. A later check does not notify again and does not approve.

Notify events are JSON logs (`msg: hitl`) unless a caller supplies `HitlBinding.notify`. The log fields are `taskId`, `sessionId`, `point`, `kind`, `status`, `reason`, and `timeoutAt`.

## Configuration

`workflows/default-task.yaml` holds `hitl`. Environment variables override it:

| Variable                          | Meaning                                              |
| --------------------------------- | ---------------------------------------------------- |
| `OPTIO_HITL_PLAN`                 | `off`, `when_confidence_low`, or `always`            |
| `OPTIO_HITL_MERGE`                | same values                                          |
| `OPTIO_HITL_CONFIDENCE_THRESHOLD` | `0`–`1`, both points                                 |
| `OPTIO_HITL_TIMEOUT_MS`           | pause deadline; `0` is already due on the next check |
| `OPTIO_HITL_POLL_MS`              | delay between BullMQ checks                          |

An invalid mode or a non-numeric threshold throws at process start. The orchestrator does not fall open.
