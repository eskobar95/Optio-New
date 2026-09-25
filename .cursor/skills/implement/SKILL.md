---
name: implement
description: Implement a delegated Linear issue. TDD at spec seams, spawn domain helpers, open a PR into the integration lane. Use for delegated Backlog issues and for resuming Implementing.
disable-model-invocation: true
---

# Implement

Load `factory.config.json` then `WORKFLOW.md`. Resolve names from [../_shared/factory.md](../_shared/factory.md). If `linear.setup.json` is missing, stop and run `/bootstrap-linear`.

Implement the work on Linear issue `{{ issue.identifier }}` (spec + tickets + comments).

Use `/tdd` where possible, at the seams already listed in the spec’s Testing Decisions (`/codebase-design` vocabulary). Do not quiz for seams during an unattended run. A hard repro with no loop yet → `/diagnosing-bugs` first, then TDD at the seam.

Run typechecking regularly and single test files during the loop. Before `In Review`, run the **full** test graph (`pnpm test` or the repo’s equivalent) — a targeted filter is not a substitute. Wait for **all** required GitHub checks on the PR (including image/deploy smokes), not only `test`.

Do **not** run `/code-review` as the pass verdict. Checker owns that in a fresh VM. You run the mechanical **pre-review gate** below instead.

Do not treat “commit to the current branch” as done. The factory exit is a PR into the integration lane, proof on Linear, and status `In Review`.

## Unattended run

1. Status must be `Implementing`. If it is `dispatch.state`, stop — planner claims, you do not. Resume when a branch/PR already exists (checker or land sent work back). Same branch.
2. Every run: Linear `get_issue` **and** `list_comments` on this issue. `get_issue` does not return comments. Find the workpad (`agent.workpadHeading`). If a GitHub PR is attached, also read PR review comments.
3. On resume, treat `### Review feedback` and other issue/PR comments as the change request. Do not start a new branch. **Fix the class, not the instance** — if feedback names `ci.yml` missing `JWT_SECRET`, grep every workflow that boots the API; if it names one design-system miss, re-read the lock against the whole UI diff.
4. One workpad comment. Start: branch from `origin/<lanes.integration>`. One issue, one PR **into that lane**. Title `<teamKey>-n: …`.
5. Out of scope → `/signal-up` (cap `agent.signalUpCapPerRun`). Ratchet files required by `### Review feedback` are in-scope (`docs/agents/write-scope.md`).
6. Upload VM screenshots/recordings to this Linear issue, then comment and link under `### Evidence`.
7. After the PR is attached **and the pre-review gate passes**: clear addressed review feedback, move to `In Review`. Do not merge. Do not move to `Done`.
8. If `### Review feedback` required a ratchet, land it in this PR (`docs/agents/error-ratcheting.md`). Tighten only.

## Pre-review gate (do not skip)

Do not move to `In Review` until all of these are true. Record the commands under workpad `### Validation`.

1. **Locks** — if the slice has UI, read `docs/design-system.md` (tokens, type roles, tab-bar anatomy, component inventory). If it has Nest `/v1` or auth, read `{paths.specs}/Architecture/tech-stack.md` (module boundaries + auth). Flag gaps; do not invent.
2. **Roles** — spawn every matching Role (`/tdd`): Frontend, Backend, DevOps. A slice that touches Nest HTTP and Expo screens whose workpad says `(none)` is a process miss. If the issue cites `docs/design-system.md` or named lock components (Search, Sheet, Mark, Banner, Tab bar, Empty state), **Frontend** must run — Backend+DevOps alone is not enough.
3. **Lane** — `git fetch origin <lanes.integration>` and rebase or merge so `gh pr view --json mergeable` is `MERGEABLE`. Behind the lane is not shippable.
4. **Tests** — full graph, not only the files you touched. Typecheck every package whose src **or tests** you edited (`pnpm --filter <pkg> typecheck`), not only the client.
5. **CI** — wait until **every** required GitHub check is green or skipped-by-design. Image/deploy smokes count. Pending **or red** → stay on the branch; do not flip status.
6. **Env class** — if you added a required process env (fail-fast at boot), grep `.github/workflows/**` for every job that `docker run`s or otherwise boots that process, and set the var there too.
7. **AC evidence** — every acceptance criterion (and every What to build clause) has a Validation command or Evidence screenshot. Ticking the workpad box is not evidence. Spec source is the whole issue body, not AC alone.

## Domain helpers

`/tdd` lists `paths.helpers` and spawns **Role** matches from each file’s YAML `description`. v1 roles: Frontend, Backend, DevOps. Skip planner, checker, release, and files whose description says they are a deprecated alias. Do not hardcode stack names (Expo, Nest, design-system) as agent ids.

When a Role matches, it loads **Area skills** on demand: Expo, Nest, design-system — not as spawned agents. Record Role names and any Area skills under workpad `### Domain helpers used`. Product docs win if they conflict with a vendor Expo default.

This implementer still owns the workpad, the branch, `/signal-up`, the PR, and the move to `In Review`. Planner owns claim. Role subagents must not do those.
