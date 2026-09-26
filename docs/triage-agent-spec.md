# Triage agent

Product voice 2026-09-26. This file is the spec for a **standalone** agent. It does not replace a Linear workflow spec, and it does not add a BullMQ stage.

The agent is one assessor. It reads raw signals that sit in Linear **Triage** and decides whether each signal is real work before anyone treats it as a backlog item.

## Purpose

Stop unreviewed signals from becoming work items. The agent receives a problem report in Triage, checks it, and either promotes a well-formed issue or closes the Triage entry with a written reason.

## Input

A raw signal is an unstructured problem report. Sources:

| Source | What arrives |
| --- | --- |
| Users | A report filed by a person |
| The agent itself | A note the agent writes when it hits something unclear during other work |
| External sources | A report from outside the team (monitor, partner, import) |

Every signal lands as a Linear issue in **Triage** on the **Engineering (ENG)** team board, unless configuration names another team. Triage is the only status this agent polls for new work.

The signal may be incomplete. Title and description are enough to start. The agent does not require acceptance criteria on the way in; it writes those only when it promotes the signal.

## Research

Two steps, in order. Both finish before the agent applies an outcome. Both are written up as comments on the Triage issue (see [Logging](#logging)).

### 1. Existing ENG issues

Search open and closed issues on the ENG team for the same problem. The search includes Backlog and in-progress issues, not only other Triage entries.

Compare the signal with issue titles and descriptions. A candidate whose match score is at or above `duplicate_match_threshold` is a duplicate (see [Configuration](#configuration)).

On a duplicate, the agent merges the signal into that existing issue and does not open a new Backlog issue. The merge adds context from the signal: what was reported, who or what reported it, and any detail the existing issue does not already contain.

### 2. Codebase

Read the repository the signal names. When the signal names none, read the ENG default repo. Decide whether the report matches the code or is a misunderstanding of current behavior.

This step still runs after a duplicate match. The codebase note is context on the Triage issue. It does not create a second issue when step 1 already matched.

## Outcomes

Exactly one decisive outcome when the agent is sure. Each one closes the Triage entry after the comments in [Logging](#logging) are on the issue.

| Outcome | When | What the agent does |
| --- | --- | --- |
| **Real issue** | No duplicate at or above the threshold, and the codebase check shows a real problem | Create one issue in **Backlog** with title, description, acceptance criteria, and labels. Close the Triage entry. |
| **Duplicate** | An ENG issue matches at or above the threshold | Add the signal's context on that issue. Close the Triage entry. Do not create a Backlog issue. |
| **Noise / not relevant** | The report is a misunderstanding, out of scope for ENG, or not a problem in the code | Close the Triage entry. The close comment states the rationale. |

The Backlog issue is the work item. Acceptance criteria are observable done conditions drawn from the signal and the codebase check. Labels are the ones that issue needs so someone can pick it up. This spec does not define a label taxonomy.

When the agent is not sure which row applies, it does not pick one. See [Autonomy](#autonomy).

## Output

One of:

- A complete Backlog issue: title, description, acceptance criteria, and labels, written so a later worker can start without re-interpreting the raw signal.
- A closed Triage entry whose comments explain the research and the decision (duplicate or noise).

The Triage issue remains the record of how that output was chosen.

## Logging

The history lives on the Triage issue as Linear comments. The agent comments, in this order:

1. **Duplicate search** — query scope (team ENG), candidates considered, match scores, and whether any candidate met the threshold.
2. **Codebase check** — repo inspected, what the code actually does, and whether that supports or contradicts the signal.
3. **Decision** — `real issue`, `duplicate`, `noise / not relevant`, or `escalate`.
4. **Rationale** — why that decision follows from the two research comments. For a duplicate, name the target issue. For a real issue, link the new Backlog issue. For noise, state why the signal is not work.

Comments stay free of secrets: no API keys, webhook signing secrets, tokens, or credential material.

## Autonomy

The agent runs on its own for every Triage signal it can classify. A human is in the loop only when the agent is uncertain: the duplicate score sits on the threshold with no clear winner, the codebase check is ambiguous, or the signal is too thin to tell real from noise.

Escalation is a comment on the same Triage issue. The comment states what was checked, what is unclear, and what the agent needs a person to decide. The Triage entry stays open. The agent does not create a Backlog issue and does not close the entry until a later run, after that decision, can apply one of the three outcomes.

## Relationship to the Linear workflow

Triage on the ENG board is the intake lane for **this** agent. Promotion to **Backlog** hands the issue to the main Linear workflow. From Backlog onward, that workflow owns priority, pickup, and completion. This agent does not plan, implement, review, or merge the Backlog issue.

The Optio-New factory (New Bot intake and the BullMQ stages plan → implement → review → ready → merge) is the path for work that has already been accepted. A Triage signal does not enter that path. A Backlog issue this agent creates can enter it later, under the normal intake rules.

Team **FIN** status-change intake (`POST /webhooks/linear`, comment body `queued`) is a separate adapter. See [ops/intake-adapters.md](ops/intake-adapters.md). This spec does not change that route.

Linear Agent Sessions stay out of this agent. Assessment is comments, a possible Backlog create, and a Triage close. It is not an Agent Session.

## Non-goals

- Editing or absorbing the Linear workflow spec. Board rules after Backlog stay in that spec.
- A factory stage named Triage, or Linear status names as BullMQ queues.
- Starting implementation, opening a pull request, or merging from a Triage signal.
- Rewriting unrelated ENG issues. A duplicate merge only appends context from the signal.
- Label taxonomies, priority scoring, and sprint placement.
- Secrets in the repo, in comments, or in this document.

## Configuration

Values below are knobs. This document does not set production secrets and does not ship an implementation.

| Knob | Default | Meaning |
| --- | --- | --- |
| `team_key` | `ENG` | Linear team whose Triage issues the agent reads, and whose issues it searches for duplicates. |
| `duplicate_match_threshold` | open | Minimum match score, on a 0–1 scale, before step 1 treats a candidate as a duplicate. A score below the threshold is not a merge. The numeric default is unset until the team picks one. |

An invalid `team_key` or a threshold outside `[0, 1]` is a configuration error. The agent does not process the queue under that configuration.
