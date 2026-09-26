# Eve patterns in Optio-New

SPEC §2, §4, §5, §6.5, and §14.0. This page splits Eve’s filesystem shape from the runtime Optio owns.

EVE-1 is layout and this contract. It does not add a loader for `agents/*/skills/index.json` (`src/agent/skills.ts` still reads `.cursor/` directly), an eve-runner HTTP API, or Vercel hosting.

## Eve-compatible (filesystem)

Agents, specialists, and skills are directories and markdown, not rows in a database.

| Slot             | Path                                                  | Contents                                           |
| ---------------- | ----------------------------------------------------- | -------------------------------------------------- |
| Phase agent      | `agents/{planner,implementation,review,ready,merge}/` | `agent.ts`, `instructions.md`, `tools/`, `skills/` |
| Subagent         | `specialists/{front-end,back-end,devops,database}/`   | `agent.ts`, `instructions.md`, optional `tools/`   |
| Skill refs       | `agents/<phase>/skills/index.json`                    | Ids and Cursor paths only                          |
| Specialist index | `specialists/index.json`                              | Ids → `.cursor/agents`                             |

`agent.ts` is a policy stub. `model.selection` is `"orchestrator"` (the worker / Jev hop chooses the model). `toolPolicy.advancesWorkflow` is `false`. `gates` copies that step’s `entry_gates`, `exit_gates`, and `on_fail` / `on_success` when `workflows/default-task.yaml` sets them. `toolPolicy.mode` records intent (`read_only`, `worktree_mutate`, `pr_only`, `merge_only`). EVE-1 does not enforce that enum in a runner. `tools/` may contain only `README.md` until a phase needs a typed tool.

`instructions.md` is the always-on prompt. It names specialist ids and skill ids. It does not embed specialist prompts or skill bodies.

`specialists/*` is the Eve `subagents/` mirror: a fresh slot the implementation phase may call, sharing the task worktree, without inheriting another phase’s skill budget. See `specialists/README.md`.

## Source of truth

| Kind        | Canonical body                 | Harness slot                                                                    |
| ----------- | ------------------------------ | ------------------------------------------------------------------------------- |
| Skills      | `.cursor/skills/<id>/SKILL.md` | `skills/index.json` and `agents/<phase>/skills/index.json`                      |
| Specialists | `.cursor/agents/<id>.md`       | `specialists/index.json` plus a thin `instructions.md` that points at that file |

`source_of_truth_root` on both indexes stays `.cursor/skills` or `.cursor/agents`. Do not copy `SKILL.md` or specialist prompt bodies into `agents/` or `specialists/`. Staging trees under `harness/staging/` and `specs/harness-working-skills/` are historical snapshots, not a second source of truth.

Phase skill budgets follow `workflows/default-task.yaml`:

| Phase          | `skills/index.json` `budget_mode` | Ids                                                       |
| -------------- | --------------------------------- | --------------------------------------------------------- |
| planner        | `fixed`                           | `skills/_shared`, `skills/bot-session`                    |
| implementation | `from_planner_selection`          | candidates tagged `implementation` in `skills/index.json` |
| review         | `fixed`                           | `skills/code-review`                                      |
| ready          | `fixed`                           | `skills/land`, `skills/sync-development`                  |
| merge          | `fixed`                           | `skills/land`, `skills/reap-worktree`                     |

The planner narrows the implementation candidate pool. The orchestrator still blocks loads outside the active allow-list.

## Optio-owned (runtime)

| Concern                                               | Owner                                                                    | Not used                                 |
| ----------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------- |
| Stage graph plan → implement → review → ready → merge | BullMQ workers (`src/orchestrator/jobs/`, `workflows/default-task.yaml`) | Vercel Workflows, WDK, Inngest, Temporal |
| Isolation for a task                                  | Git worktree (`src/orchestrator/worktrees/`)                             | Vercel Sandbox                           |
| When to pause, elicit, or advance                     | New Bot                                                                  | Linear                                   |
| Code mutation                                         | CodingAgent adapters (`src/adapters/cursor`, `src/adapters/codex`)       | An Eve process entrypoint                |
| Decision hot path                                     | Jev via Vercel AI Gateway only                                           | Vercel-hosted control plane              |

Phase agents and specialists return results. They do not enqueue the next stage, merge on their own, or delete the worktree. The orchestrator does that (`docs/pipeline.md`).

A worktree is the sandbox: one directory per task, sparse-checkout omits `.cursor/` skill and specialist bodies (§6.5), and merge success reaps it. There is no Vercel Sandbox client in this repo.

## Out of scope here

- A SkillLoader that resolves `agents/*/skills/index.json`. `createInstalledSkillLoader` keeps reading `.cursor/skills` and `.cursor/agents`.
- `eve start`, eve-runner HTTP, or replacing the stub command in `Dockerfile.eve-runner`.
- Hosting the control plane on Vercel. Vercel in v1 is the AI Gateway base URL for Jev (§14.3).
