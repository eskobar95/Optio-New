---
name: reap-worktree
description: After land or issue Done, verify the issue worktree branch is on origin/integration, then remove the worktree and delete the merged remote branch. Use when /land succeeds, /issue-session completes, or cwd is an issue worktree for a Done issue.
---

# Reap worktree

Load `factory.config.json` then `WORKFLOW.md`. Resolve names from [../_shared/factory.md](../_shared/factory.md).

**Worktree reap** is the post-land hygiene pass: confirm the issue branch is on `origin/<lanes.integration>`, then drop the local issue worktree and the merged remote branch so Desktop checkouts do not pile up.

This skill is Desktop / Cloud Agent hygiene. The PI worker reaps `/var/lib/kit-pi/worktrees/KIT-n` on its own schedule — same intent, different paths. Details: [references/paths.md](references/paths.md).

## Factory twist

- Run only after land success (`Done` + merge SHA on `origin/<lanes.integration>`) or when the human explicitly names a merged issue.
- Never reap while the issue is still `Implementing`, `In Review`, `Ready for merge`, or `Merging`.
- Never push to `lanes.staging` or `lanes.production` from this skill.
- `/issue-session` and `/land` follow this skill by reading it — they do not slash-invoke it.

## Inputs

Collect from the message or cwd:

1. **Identifier** — `<teamKey>-n` (optional if cwd path or branch name implies it).
2. **Merge SHA** — from the land role comment, workpad, or `gh pr view --json mergeCommit` (optional; inferred when missing).
3. **Worktree path** — default: current workspace root if it is an issue worktree; else discover via `git worktree list`.

If identifier, worktree, and branch cannot be resolved, ask once.

## Process

### 1. Load context

- Linear `get_issue` when MCP is available — status must be **Done** (or human explicitly overrides after verifying merge).
- Read workpad / last **Land → Done** role comment for merge SHA and branch name.
- `git worktree list` from the **main** repo (see [references/paths.md](references/paths.md)).

### 2. Verify landed

Fetch once: `git fetch origin <lanes.integration>`.

**Green** when all hold:

1. Merge SHA (or PR merge commit) is contained in `origin/<lanes.integration>`:  
   `git merge-base --is-ancestor <sha> origin/<lanes.integration>`
2. Issue branch tip is an ancestor of `origin/<lanes.integration>` (merge commit or fast-forward path):  
   `git merge-base --is-ancestor <branch-tip> origin/<lanes.integration>`
3. Worktree working tree is clean: `git status --porcelain` empty.

If (1–2) fail → **stop and fix** (step 3). If (3) fails → stash wanted edits, then re-verify; do not `--force` remove unless the human asked to discard local edits.

### 3. Fix path (not landed)

Fix only what the evidence supports — never widen scope.

| Situation | Action |
| --- | --- |
| PR merged but local `origin/<integration>` stale | `git fetch origin <lanes.integration>` and re-check step 2 |
| PR not merged; issue still open | Stop — resume `/land` or `/issue-session`; do not reap |
| Unpushed commits on issue branch; PR open | Push branch, finish review/land; do not reap |
| Land claimed Done but SHA not on integration | Stop — comment on issue; move back to `Implementing` if you own the pipeline |
| Dirty worktree with wanted edits | Stash or commit on the issue branch, push if needed, then re-verify |

Re-run step 2 after a fix. Stop after two failed verify cycles and role-comment the blocker.

### 4. Reap (landed + clean)

From the **main** repo (not from inside the issue worktree if hooks block push/remove there):

1. Note branch name bound to the worktree (`git worktree list`).
2. `git worktree remove <worktree-path>` — add `--force` only when status is clean and remove refuses a locked path after closing editors.
3. If the directory remains, delete it only when `git worktree list` no longer registers it.
4. Delete remote issue branch when fully merged:  
   `git push origin --delete <branch>`  
   Skip when the branch is `lanes.integration`, default branch, or still referenced by an open PR.
5. In the main repo: `git checkout <lanes.integration>` && `git pull --ff-only origin <lanes.integration>`.

Report: worktree path removed, remote branch deleted or skipped (with reason), main repo now at integration SHA.

## Completion

Done when verify is green, the issue worktree is gone from `git worktree list`, and the human has a one-line summary (integration SHA, deleted branch or skip reason).

If Cursor workspace root was the reaped worktree, tell the human to open the main repo path — do not leave them in a deleted directory.
