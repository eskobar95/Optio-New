---
name: land
description: Merges the GitHub PR for a Linear issue after the approver moved it to Merging. Integration lane only. Use when an issue status becomes Merging. Moves to Done only after merge succeeds.
---

# Land

Read [../_shared/factory.md](../_shared/factory.md). Details: [references/merge.md](references/merge.md).

The merge gate is `scripts/lib/land-policy.mjs` (`landAtMergeGate`). The archived Pi harness job `land.mjs` called that gate at the seam — see [pi-harness-archived.md](../../docs/agents/pi-harness-archived.md). Do not merge from `Done`; `Done` means the PR is already on `lanes.integration`.

After merge success and `Done`, follow [reap-worktree/SKILL.md](../reap-worktree/SKILL.md) to verify integration and reap the issue worktree.

## Orchestrator

`landAtMergeGate` (`src/orchestrator/linear/land.ts`) is the gate: CI must be green, and the review verdict for that head must be pass. Done is written only after `github.merge` succeeds. The merge method stays `merge`.

Before that call, `prepareMergeWorktree` (`src/orchestrator/git/merge-update.ts`) updates the task branch against the pull request base:

- The stored pull-request base wins. Linear opens against `main`. Other tasks use the catalog `defaultBranch` (`development`, unless `OPTIO_NEW_BASE_BRANCH` is set).
- Behind and clean: `git merge` that base into the task branch, then `git push` of `head:head`.
- Behind and conflicting: the merge agent reads this skill, `skills/codebase-design`, and `skills/diagnosing-bugs`, and resolves the markers in the worktree.
- A resolution that leaves markers, unmerged paths, or `OPTIO_REVIEW_VERDICT fail` runs `git merge --abort` and returns the issue to In Progress with the review handoff. The pull request is not merged.
- Force-push is refused. The target branch is never pushed. After an update, land waits until CI on the new head is green.
