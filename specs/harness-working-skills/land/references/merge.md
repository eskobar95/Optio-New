# Merge

The `approver` moving the issue to `Merging` is merge approval.

1. Status must be `Merging`. Otherwise stop.
2. Linked PR must target `lanes.integration`, checker passed, CI green.
3. `gh pr merge --merge` (no `--force`). `--merge` is required when `gh` has no TTY. Never `lanes.staging` or `lanes.production`. Follow `scripts/lib/land-policy.mjs` via `harness/land.mjs`.
   `gh pr create` must pass `--base development` (repo default is `development`). Promotion creates are `--base staging --head development` or `--base production --head staging` only. The Cursor hook `.cursor/hooks/block-pr-lane.sh` denies the rest.
4. Merge fail → `Implementing` and write the merge error under workpad `### Review feedback`. Success → `Done`, record the SHA in the workpad. Never `Done` on a failed merge.
5. Dependents stay blocked until the blocker is `Done` or `Canceled`. `Ready for merge` → `Merging` does not resolve `blockedBy`.

Never force-push the integration lane.
