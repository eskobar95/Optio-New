# Permission tiers

Agent shell, git, and host actions run under one of four tiers. The CodingAgent adapters (`src/adapters/cursor`, `src/adapters/codex`) and the kit-harness tool gate (`decideTool`) both enforce the same policy (`src/kit-harness/permissions.ts`). A deny does not execute the action. The agent receives `observation` text that names the granted tier, the action, and the tier that would allow it.

`host-admin` is never a stage default. Set `permission_tier` on the run or the tool context to opt in.

## Tiers

| Tier            | Allows                                                                                           | Blocks                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `read-only`     | Read the worktree. Inspect with `git status`, `git diff`, `git log`, `ls`, `cat`.                | Edits, `git commit`, `git push`, sops keys, `/root`, `docker.sock`.                       |
| `edit-worktree` | `read-only`, plus edits and local commands inside the worktree (`npm test`, `git commit`).       | `git push`, sops keys, `/root`, `docker.sock`.                                            |
| `git-push`      | `edit-worktree`, plus `git push` of a non-protected branch.                                      | Force-push, push to `main` / `master` / `development`, sops keys, `/root`, `docker.sock`. |
| `host-admin`    | `git-push`, plus sops keys (age keys, `sops` decrypt, `.sops.yaml`), `/root`, and `docker.sock`. | `rm -rf`, force-push, protected-branch push, and ordinary secret reads such as `.env`.    |

Hard denies stay hard on every tier. A destructive command, a secret that is not in the host class, and a harness self-config write are still denied. An advisor cannot override those, and it cannot override a tier deny.

## Stage defaults

`workflows/default-task.yaml` records the default. An unknown step id is `read-only`. Pipeline step names (`invoke_implementation`, `invoke_review`, `invoke_planner`, `open_pr`, `merge_branch`) use the same tier as their stage.

| Stage          | Default         |
| -------------- | --------------- |
| planner        | `read-only`     |
| implementation | `edit-worktree` |
| review         | `read-only`     |
| ready          | `git-push`      |
| merge          | `git-push`      |

The production handler passes that tier into `CodingAgent.run`. Planner and review get `allowed_tools: ["read"]`. Implementation gets `shell`, `edit`, and `write`, and does not get `git_push`.

## Where it is enforced

1. **Tool gate.** `decideTool` resolves the tier from `context.permission_tier` or `context.step_id`. A miss returns `decision: "deny"`, `reason: "permission_denied"`, and `observation`. `invokeGuardedTool` copies `observation` onto the result and does not run the tool.
2. **CodingAgent adapter.** Before credentials and before the CLI starts, the adapter compares `allowed_tools` with the tier. A miss returns `status: "failed"`, `error_class: "permission_denied"`, and the same sentence in `logs` and `observation`. The sandbox matches the tier that is actually granted:
   - `read-only` — Cursor `--sandbox enabled` (no `--force`); Codex `read-only`.
   - `edit-worktree` and `git-push` — Cursor `--sandbox enabled --force`; Codex `workspace-write`.
   - `host-admin` — Cursor `--force` without a sandbox; Codex `danger-full-access`.

A read-only tool list stays in the read-only sandbox even when the stage default is higher. `host-admin` opens the host sandbox only when the tool list asks for `docker`, `sops`, `host`, or `host_admin`.
