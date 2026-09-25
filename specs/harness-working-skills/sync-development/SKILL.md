---
name: sync-development
description: Safely sync the local integration lane with origin. Use when pulling latest development, catching up with remote, or before starting new work on the main repo.
disable-model-invocation: true
---

# Sync development

Load `factory.config.json` then `WORKFLOW.md`. Resolve names from [../_shared/factory.md](../_shared/factory.md).

**Safe sync** is a fetch + fast-forward pull on `lanes.integration` — never a blind merge, never force-push, never silent discard of local commits.

Desktop / main-repo hygiene. Issue worktrees keep their own branches; this skill updates the **main** checkout at `lanes.integration`. Details: [references/worktrees.md](references/worktrees.md).

## Factory twist

- Resolve the branch from `lanes.integration` (KitCollective: `development`). Do not hardcode lane names.
- Run from the **main** repo root — not from inside an issue worktree unless the human explicitly wants that worktree's branch synced.
- Never push to `lanes.staging` or `lanes.production` from this skill.
- Never `git pull` without `--ff-only`, never `git push --force`, never `git reset --hard` unless the human explicitly asked after seeing the diverge report.
- Stash uncommitted WIP before checkout; restore after sync. Label stashes so resume is obvious.
- Optional deterministic path: `bash scripts/sync-development.sh` from repo root (same steps as below).

## Inputs

Collect from the message or cwd:

1. **Repo root** — default: workspace root when it is the main repo; else discover via `git worktree list` (see [references/worktrees.md](references/worktrees.md)).
2. **Stash policy** — default: stash dirty trees automatically; ask once when the human said "do not stash".

If repo root cannot be resolved, ask once.

## Process

### 1. Pre-flight

From the main repo:

```bash
git status -sb
git branch --show-current
git worktree list
```

Record:

- Current branch
- Whether the working tree is dirty (`git status --porcelain`)
- Whether cwd is an issue worktree (path or branch matches `<teamKey>-<n>`)

If cwd is an issue worktree and the human did not ask to sync **that** worktree → `cd` to the main repo first, then continue.

### 2. Diverge check (before mutating)

```bash
git fetch origin <lanes.integration>
```

Compare local integration tip to remote:

```bash
git rev-parse <lanes.integration> 2>/dev/null || echo "no-local-branch"
git rev-parse origin/<lanes.integration>
git rev-list --left-right --count <lanes.integration>...origin/<lanes.integration> 2>/dev/null || true
```

| Counts | Meaning | Action |
| --- | --- | --- |
| `0  N` (behind only) | Safe fast-forward | Continue to step 3 |
| `N  0` (ahead only) | Local commits not on remote | **Stop** — report SHA range; human chooses push, new branch, or discard |
| `N  M` (both) | Diverged | **Stop** — report both sides; human chooses rebase, merge, or reset. Do not auto-pick |
| no local branch | First checkout | Continue to step 3 |

### 3. Stash WIP (when dirty)

When `git status --porcelain` is non-empty and stash is allowed:

```bash
git stash push -u -m "sync-development-wip-$(date +%Y%m%d)"
```

If stash is refused (human said keep edits in tree) and branch is not `<lanes.integration>` → stop: cannot checkout safely.

### 4. Checkout integration + fast-forward pull

```bash
git checkout <lanes.integration>
git pull --ff-only origin <lanes.integration>
```

`--ff-only` failing means diverge appeared between step 2 and 4 — return to step 2 report; do not merge.

### 5. Restore stash

When step 3 stashed:

```bash
git stash pop
```

Conflicts on pop → stop with conflict file list; human resolves. Do not `--force` checkout over conflicts.

When step 3 skipped but tree is clean after pull, optionally pop a leftover `sync-development-wip-*` stash from a prior interrupted run (newest matching entry in `git stash list`).

### 6. Report

One-line summary:

- `origin/<lanes.integration>` SHA (`git rev-parse --short HEAD`)
- behind/ahead counts (should be `0 0` when sync succeeded)
- stash created/restored/skipped
- warning if local integration was ahead or diverged (when human overrode stop)

## Completion

Done when `git merge-base --is-ancestor HEAD origin/<lanes.integration>` and `HEAD` equals `origin/<lanes.integration>` (fully caught up), working tree state matches human intent (stash restored or intentionally left stashed), and the human has the one-line summary.

## Fix path

| Situation | Action |
| --- | --- |
| `pull --ff-only` rejected | Re-run diverge check; present options; do not `git pull` without `--ff-only` |
| Dirty tree on wrong branch | Stash, then checkout integration |
| Ahead commits the human wants to keep | `git branch backup/<name>` then reset or push — only after human confirms |
| Issue worktree needs integration tip | In that worktree: merge or rebase `origin/<lanes.integration>` into the issue branch — separate from this skill unless human asks |
