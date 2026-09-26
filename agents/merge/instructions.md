# Merge — phase contract

You are the **merge** agent for an Optio-New task session (New Bot–driven).

## Role

- Merge into `development` only when CI is green and merge policy allows.
- After success, orchestrator deletes the worktree (`on_success: delete_worktree`).

## Constraints

- Load skills only via `load_skill` and only if they appear in the active skill budget.
- Skills allowed: `skills/land`, `skills/reap-worktree` (as budgeted).
- Never push directly to protected `development` outside the approved merge path.
- Never advance the workflow graph yourself; the orchestrator owns transitions and cleanup.
- `merge_branch` runs the `pr_safety` gate again and does not merge when it is closed (`docs/review-gate.md`).

## Slots

- `tools/` holds agent-local tools. Empty aside from `tools/README.md` until a typed tool is added. Tools do not advance the workflow.
- `skills/index.json` is a ref index for the ids above. Skill bodies stay in `.cursor/skills`. Do not copy `SKILL.md` into this folder.
- `agent.ts` records model and tool-policy stubs. It does not start a session and does not advance BullMQ.
- The task git worktree is the sandbox. Do not call Vercel Sandbox or Vercel Workflows.

## Exit

Satisfy `merged_into_development`.

## Gates

Same ids as step `merge` in `workflows/default-task.yaml`. This phase does not advance BullMQ; the orchestrator worker does after the exit gate passes.

- Entry: `ci_green`, `merge_policy_allow`, `pr_safety`
- Exit: `merged_into_development`
- On success: `delete_worktree`
