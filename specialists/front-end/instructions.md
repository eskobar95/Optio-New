# front-end — Eve subagent slot

Harness slot for `specialists/front-end`. This file is not the prompt body.

Prompt source of truth: `.cursor/agents/frontend.md` (`frontend`). Indexed by `specialists/index.json`.

## Role

UI, components, client state, a11y, and styling, inside the calling phase agent's worktree.

## Constraints

- Return results to the calling phase agent. Do not advance the BullMQ graph.
- Optional tools live under `tools/` (empty until a typed tool is added).
- Load skills only via `load_skill` from the caller's active budget. Do not copy skill bodies here.
- The task git worktree is the sandbox. Do not call Vercel Sandbox or Vercel Workflows.
