---
name: handoff
description: Compact the current conversation into a handoff document for another agent to pick up.
disable-model-invocation: true
---

# Handoff

Load `factory.config.json` then `WORKFLOW.md` when this run is part of the factory. Read [../_shared/factory.md](../_shared/factory.md). See [../ask-me/PHASE-BOUNDARIES.md](../ask-me/PHASE-BOUNDARIES.md) for when a handoff is the right move.

Write a handoff document summarising the current conversation so a fresh agent can continue the work.

## Factory twist

- **Where it goes.** Default: OS temp (`$TMPDIR/handoff-<timestamp>.md`) — nothing lands in the repo. If the next session is another agent **on this repo** (Cloud Agent, colleague, new directory), write `{paths.specs}/<effort>/handoff.md` so the file travels.
- **Suggested skills** use this factory’s names: `/grill-with-docs` not `/grill-me`, `/ask-me` not `/ask-matt`, `/to-spec` / `/implement` / `/tdd` / `/land`.
- **Redact** secrets, cookies, `Authorization` headers, `LINEAR_API_KEY`, connection strings. Write `[REDACTED]`.
- A handoff does not move Linear, open a PR, or `/land`.

Do not duplicate content already captured in other artifacts (specs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead.

If the user passed arguments, treat them as a description of what the next session will focus on and tailor the doc accordingly.
