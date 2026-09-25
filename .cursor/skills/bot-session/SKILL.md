---
name: bot-session
description: New Bot (Grok Bot) is the intake and decision layer for Optio-New tasks. No Linear API.
---

# bot-session

## Role

**New Bot** (Grok Bot / Cursor agent) is the control plane for Optio-New:

- Receives human intent in chat (or optional HTTP intake).
- Decides what to build, when to pause, and when to advance stages.
- Enqueues BullMQ jobs; does **not** call Linear GraphQL, webhooks, or Agent Sessions.

## When to use

- Starting a new task session from chat.
- Mapping a user request to the default pipeline: plan → implement → review → ready → merge.
- Escalating ambiguity back to the human in chat (elicitation), not to an issue tracker.

## Do not

- Create or update Linear issues, statuses, or Agent Activities.
- Poll Linear backlogs.
- Treat Linear as a required dependency for v1.

## Related

- Pipeline orchestrator: BullMQ (`orchestrator/jobs/`, SPEC §14.0)
- Intake adapter: `orchestrator/intake/`
- Workflow: `workflows/default-task.yaml`
