---
name: issue-session
description: Desktop pipeline for one Linear issue or a batch — Implementing, isolated code-review with a fix loop, then land. Sequential or parallel.
disable-model-invocation: true
---

# Issue session start

Load `factory.config.json` then `WORKFLOW.md`. Resolve names from [../_shared/factory.md](../_shared/factory.md). If `linear.setup.json` is missing, stop and run `/bootstrap-linear`.

Run the **pipeline** on the issues the human named: implement until the pre-review gate is clean, **fresh review** in an isolated sub-agent, **fix the class** when review returns work, then land into `lanes.integration`. A **batch** is several identifiers in one invocation — sequential or parallel.

This skill is Desktop / Cloud Agent. It is not PI-worker dispatch and does not set Linear Agent to Cursor.

## Factory twist

- Follow [implement/SKILL.md](../implement/SKILL.md) by reading it. Do not slash-invoke `/implement` (user-invoked skills cannot fire each other).
- Invoke `/code-review` only inside a **fresh** Task sub-agent (empty conversation, judge only). That isolation is the Desktop stand-in for checker’s fresh VM. The parent never treats its own reading of the diff as the pass verdict.
- Invoke `/land` after this session has moved the issue to `Merging`. Human invocation of this skill **is** approver-present merge permission for the named issues. Still merge only into `lanes.integration`. Never staging or production.
- Status names come from factory config. Do not invent states.
- `/tdd`, `/signal-up`, `/diagnosing-bugs`, `/codebase-design` may run from inside the implement follow-through (model-invoked).

## Inputs

From the human message, collect:

1. **Identifiers** — `<teamKey>-n` tokens (one or a **batch**). If none, ask once.
2. **Batch mode** — `parallel` only when the human said parallel / samtidigt. Otherwise **sequential**.
3. **Order** — if the human listed identifiers in order, keep that order. Otherwise `dispatch.priorityOrder`, oldest first at the same rank.

## Guardrails (every issue)

Stop on that identifier (do not mutate it) when any of these hold. Continue the rest of the **batch**.

- Label `signal-up`, `ready-for-human`, `needs-info`, or `wontfix`
- Status is Linear Triage, Duplicate, Canceled, or Done
- Unresolved `blockedBy` (unless the blocker is also in this **batch** and will finish first — sequential only)
- Linear Agent is Cursor (Cloud Agent path — skip and role-comment)
- Status is `Parked` unless the human named that identifier explicitly

Write-scope overlap and fan-out: [references/batch.md](references/batch.md).

## Pipeline (one issue)

Completion: Linear status is `Done` and the PR SHA is on `origin/<lanes.integration>`, **or** the issue is stopped under Guardrails / loop cap with a role comment.

### 1. Load

`get_issue` **and** `list_comments`. Workpad is the single `agent.workpadHeading` comment. Attached PR → also GitHub review comments.

### 2. Claim

If status is `dispatch.state`, labelled `ready-for-agent`, unblocked, and Agent empty: move to `Implementing`, one planner-style role comment. Assignee stays the human.

If status is already `Implementing` with `ready-for-agent`: start or resume. Same branch, same PR.

If status is `In Review`, `Ready for merge`, or `Merging`: join at the matching step below (review, approve+land, or land).

### 3. Implement

Follow [implement/SKILL.md](../implement/SKILL.md) through the pre-review gate. Move to `In Review` only when that gate is true. One implement → In Review role comment. Do not merge. Do not tick description Acceptance criteria.

### 4. Fresh review

Spawn one Task (`subagent_type` `generalPurpose` or `bugbot` only if the human asked Bugbot). Prompt: read `.cursor/skills/code-review/SKILL.md` and run it on this issue’s PR / merge-base diff. Return every hard finding; do not stop at three.

Parent aggregates:

- Required GitHub checks still pending → wait; stay `In Review`.
- Hard Spec or Standards findings, red required checks, or `CONFLICTING` → **fail**.
- Both axes clean, `MERGEABLE`, required checks green → **pass**.

### 5. Fix loop (fail)

Move to `Implementing`. Write the **full** set under workpad `### Review feedback` (file/criterion + what done looks like). One checker-style role comment with axis headings. Increment the checker-fail side of `### Loop counters`.

Then resume implement: **fix the class**, not the cited file. Re-run the pre-review gate. Return to step 4.

Stop the issue (leave `Implementing`, role-comment) when checker-fail returns hit five, or CI-fail cycles hit five (`WORKFLOW.md` loop cap). Do not land.

### 6. Pass

`Ready for merge`. Tick description Acceptance criteria `[x]`. One checker-style verdict comment per criterion. Clear addressed `### Review feedback`.

### 7. Land

Move to `Merging` (approver-present). Follow [land/SKILL.md](../land/SKILL.md) and [land/references/merge.md](../land/references/merge.md). Success → `Done` + role comment with merge SHA. Merge fail → `Implementing` + merge error under `### Review feedback` + increment `reviewLoops` + resume from step 3.

### 8. Reap worktree

After land success, follow [reap-worktree/SKILL.md](../reap-worktree/SKILL.md): verify the branch is on `origin/<lanes.integration>`, remove the issue worktree, delete the merged remote branch when safe.

## After the batch

List each identifier: landed SHA, worktree reaped (yes/no), still in loop, skipped (reason), or blocked. Do not start unnamed issues.
