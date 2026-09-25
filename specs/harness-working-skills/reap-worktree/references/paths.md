# Worktree paths

## Desktop (Cursor)

Issue sessions often use a sibling checkout:

```text
~/Projects/kit-collective          # main repo — git worktree commands run here
~/Projects/kit-collective-wt/KIT-n # issue worktree — Cursor workspace during implement
```

Discover:

```bash
git -C ~/Projects/kit-collective worktree list
```

The main repo owns worktree registration even when the agent cwd is the issue tree.

## PI worker

Issue worktrees live at `/var/lib/kit-pi/worktrees/KIT-n`. The worker reaps on land Done, Canceled, and Timeout park. Do not delete worker paths from Desktop unless you are on the box and own that runtime.

## Branch names

Issue branches follow Linear `gitBranchName` or the PR head (e.g. `kit-192-live-discovery-showcase`, `nicklas/kit-192-…`). Resolve from the linked PR — not from guessing the identifier alone.
