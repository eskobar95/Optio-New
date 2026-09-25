# Rules

1. Do not code it in this PR.
2. Create a Linear issue: status `Triage` (the Linear state, not the label group), label `signal-up` only, same project, related to the origin. `blockedBy` the origin only if it truly cannot start until this lands. Include title, description, acceptance criteria, and why it is out of scope. Do not also apply `needs-triage` while Linear’s Triage group is exclusive (a human may split that group; until then two Triage labels on one issue are rejected). Do not file into Backlog.
3. Do not delegate. Do not apply `ready-for-agent` until a human triages it.
4. Cap `agent.signalUpCapPerRun` (default 3). Further findings go in the workpad only.
5. Link the new id under workpad `### Signal-up`.

May still fix blockers of *this* issue’s acceptance, and red CI / review on *this* PR.
