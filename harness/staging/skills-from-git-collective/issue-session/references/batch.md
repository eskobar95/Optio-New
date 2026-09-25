# Batch

Read this when the human named more than one issue, or said parallel.

## Sequential (default)

Run the [SKILL.md](../SKILL.md) **pipeline** to completion (or skip/cap) on the first identifier, then the next.

Honor `blockedBy`: if B is blocked by A and both are in the batch, finish A (ideally `Done`) before starting B. If A is not in the batch and still blocks B, skip B.

Honor write-scope: two issues with overlapping `write-scope:` globs never share an Implementing stay. Sequential already serializes them. An issue with no `write-scope:` line does not skip others for path overlap.

One git checkout: sequential uses this workspace. Land A before branching B from latest `origin/<lanes.integration>`.

## Parallel

Fan-out only when the human asked for parallel.

Each identifier gets its own Task. That child follows the full **pipeline** for that issue alone. Isolated git worktree (or Cloud Agent environment) per child — two pipelines must not share one dirty working tree.

Do **not** start two children whose `write-scope:` globs overlap. Put the later one (priority, then list order) in a sequential remainder after the earlier lands.

Do **not** start B in parallel if B `blockedBy` A. Queue B until A is `Done`.

Parent: one message with multiple Task calls for the current wave. After the wave, start the next wave (unblocked, non-overlapping). Aggregate the after-batch list.

If worktrees or Cloud Agents are unavailable, say so and run sequential instead of overlapping branches on one tree.
