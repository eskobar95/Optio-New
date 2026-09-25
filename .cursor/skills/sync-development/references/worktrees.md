# Worktrees and repo roots

## Main repo vs issue worktree

- **Main repo** — the primary checkout where `lanes.integration` is checked out for day-to-day sync. Often the path without `KIT-<n>` in the directory name.
- **Issue worktree** — a linked checkout on branch `<teamKey>-<n>` (e.g. `KIT-42`). `/implement` works here; `/sync-development` targets the main repo unless the human names the worktree.

Discover:

```bash
git worktree list
```

The first entry is usually the main worktree. Issue worktrees show a branch like `KIT-123`.

## When to sync the issue worktree instead

Only when the human explicitly asks to update **that** branch with latest integration:

1. `cd` to the issue worktree.
2. `git fetch origin <lanes.integration>`
3. `git merge --ff-only origin/<lanes.integration>` or `git rebase origin/<lanes.integration>` — per human choice. Never force.

Default `/sync-development` does **not** rebase open issue branches.
