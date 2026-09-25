# Kit Collective → coding-agent harness v1 — analysis report

**Analyzed:** 2026-09-26 ~00:40 PT (Europe/Lisbon)  
**SoT:** `/Users/nicklaseskou/Projects/kit-collective` (Mac `a1b200cb-2882-4b83-af27-63c550704f0f`)  
**Box mirror:** `/workspace/kit-collective` (not used as SoT; not written)  
**Kit Collective writes:** none (read-only)

---

## 1. Project location & inventory counts

| Area | Path | Count |
| --- | --- | --- |
| Rules | `.cursor/rules/*.mdc` | **10** |
| Skills (SKILL.md) | `.cursor/skills/**` | **53** (28 factory + 25 vendor `expo/`) |
| Sub-agents | `.cursor/agents/*.md` | **10** (4 active Roles + planner/checker/release + 3 deprecated aliases) |
| Slash commands dir | `.cursor/commands`, `.cursor/prompts` | **absent** — factory “commands” = Cursor skills (`AGENTS.md`) |
| Other agent docs | root `AGENTS.md` | present (generated from `factory.config.json`) |
| Hooks | `.cursor/hooks/` + `hooks.json` | many fail-closed shell ratchets (not staged) |
| Elsewhere rules | `RULE.md`, `.cursorrules` | **absent** |

---

## 2. Rules (all under `.cursor/rules/`)

| Path | Mode | Summary |
| --- | --- | --- |
| `project.mdc` | **always-on** (`alwaysApply: true`) | Follow CONTEXT/AGENTS; prefer small changes; error-ratchet may only tighten. |
| `orchestration.mdc` | **always-on** | Linear dispatch contract: load factory+WORKFLOW; planner claims Backlog+ready-for-agent; checker/land states; no invent statuses. |
| `scope-signal-up.mdc` | **always-on** | Work only issue AC; out-of-scope → signal-up Triage issue (cap 3); never expand PR. |
| `write-scope.mdc` | **always-on** | `write-scope:` globs are hard edit boundaries; ratchet paths exception on review feedback. |
| `pre-review-gate.mdc` | **always-on** | Implement must rebase/MERGEABLE, full tests, wait all required CI, spawn helpers, typecheck before In Review; checker owns `/code-review`. |
| `code-english.mdc` | **always-on** | Identifiers/comments/technical names English; UI copy may stay Danish per design lock. |
| `secrets.mdc` | **always-on** | No secrets in git; client/server import split; lane secrets in GitHub Environments. |
| `ops-mcp-evidence.mdc` | **always-on** | MCP ACs need same-session GetMcpTools + record script before In Review. |
| `test-database-isolation.mdc` | **always-on** | Tests must not DROP/reset shared lane Postgres; use `*_TEST_DATABASE_URL`. |
| `design-system.mdc` | **contextual** (`globs: apps/mobile/**,apps/web/**`, `alwaysApply: false`) | Follow `docs/design-system.md` lock; flag gaps; no invented tokens/primitives. |

---

## 3. Skills overview & v1 recommendation

### Factory skills (non-expo) — purpose sketch

| Name | Purpose | Harness relevance |
| --- | --- | --- |
| `implement` | Linear Implementing → PR → pre-review → In Review | **core implementation** |
| `tdd` | Red-green at seams; spawn Role helpers | **core implementation** |
| `code-review` | Standards/Spec/Slop on PR diff | **core review** |
| `land` | Merging → merge integration → Done | **core merge/git** |
| `signal-up` | File out-of-scope as Triage | **core meta** |
| `sync-development` | Safe ff sync of integration lane | **git** |
| `reap-worktree` | Post-Done worktree cleanup | **git** |
| `issue-session` | Desktop implement→review→land pipeline | **meta orchestration** |
| `diagnosing-bugs` | Repro loop before fix | **implementation support** |
| `codebase-design` | Deep module / seam vocabulary | **implementation support** |
| `handoff` | Portable phase-boundary handoff | **meta** |
| `ask-me` | Skill router + phase boundaries | optional meta |
| `create-new-skill` | Author new factory skills | later meta |
| `grill-with-docs` / `to-spec` / `to-tickets` / `to-design` | Planning stack | kickoff, not v1 code loop |
| `bootstrap-linear` | Privileged Linear board bootstrap | setup, not runtime |
| `area-*` | Nest/Expo/design-system area loaders | product domain |
| `seed-run` / `to-video-brief` / `prototype` / `research` / `wizard` / `wait-what` / `improve-codebase-architecture` | Domain or optional productivity | defer |

**Phase tags:** Most factory skills use `disable-model-invocation: true` for user-invoked entry (implement, land pipeline peers, planning). Model-invoked peers (tdd, code-review, signal-up, diagnosing-bugs, codebase-design, land, reap-worktree) omit that flag. No formal `phase:` YAML field; phases are documented in `ask-me/PHASE-BOUNDARIES.md` and AGENTS planning stack.

### Recommended MINIMAL set (11 + `_shared`)

1. **`implement`** — implementation vertical: claim-ready issue → code → PR → In Review.  
2. **`tdd`** — implementation craft + Role spawn used inside implement.  
3. **`codebase-design`** — seam vocabulary implement/tdd share.  
4. **`diagnosing-bugs`** — unblock implement when repro is missing.  
5. **`code-review`** — review vertical (checker / isolated Task).  
6. **`land`** — merge vertical after Merging approval.  
7. **`sync-development`** — git hygiene before new work.  
8. **`reap-worktree`** — git cleanup after Done.  
9. **`signal-up`** — meta scope discipline.  
10. **`issue-session`** — Desktop orchestration of implement→review→land.  
11. **`handoff`** — meta continuity across sessions.  
(+ **`_shared`**) — factory name helpers referenced by the above.

---

## 4. Sub-agents (`.cursor/agents/`)

| Name | Path | Niche | Allowed tools | Summary |
| --- | --- | --- | --- | --- |
| `planner` | `planner.md` | other (dispatch) | none listed (`model: inherit`) | Linear-only claim: Backlog+ready-for-agent+unblocked → Implementing; no code/PRs. |
| `checker` | `checker.md` | other (review) | `readonly: true` | Judge on In Review; `/code-review` + required CI green → Ready for merge; else back to Implementing. |
| `frontend` | `frontend.md` | front-end | inherit | Role from /tdd: Expo/UI/design-system; no Linear/PR ownership. |
| `backend` | `backend.md` | back-end (+ database in v1) | inherit | Role: Nest/v1/auth + Drizzle/schema; no Linear/PR ownership. |
| `devops` | `devops.md` | devops | inherit | Role: Actions/Environments/Coolify/EAS lanes; no issue ownership. |
| `release` | `release.md` | devops / other | inherit | Staging→production PR + release notes; approver merges prod. |
| `backend-nest` | `backend-nest.md` | back-end | — | **Deprecated** alias → `backend.md`. |
| `db-drizzle` | `db-drizzle.md` | database | — | **Deprecated** alias → `backend.md`. |
| `react-expo` | `react-expo.md` | front-end | — | **Deprecated** alias → `frontend.md`. |
| `ui-ux` | `ui-ux.md` | front-end | — | **Deprecated** alias → `frontend.md`. |

---

## 5. Commands → harness phase map

No `.cursor/commands/`. Slash “commands” = skills. Mapping:

| Skill / agent | Phase |
| --- | --- |
| `planner` agent | **planner** |
| `grill-with-docs`, `to-spec`, `to-tickets`, `to-design`, `bootstrap-linear` | **other** (planning/setup) |
| `implement`, `tdd`, `diagnosing-bugs`, `codebase-design`, area/expo skills | **implementation** |
| `code-review`, `checker` agent | **review** |
| (pre-review gate inside implement; Ready for merge) | **ready** |
| `land`, Auto-merge → Merging, `reap-worktree` | **merge** |
| `sync-development`, `signal-up`, `issue-session`, `handoff`, `ask-me`, … | **other** / meta |

---

## 6. Linear setup — status vocabulary & transitions

**Sources:** `linear.setup.json`, `factory.config.json`, `WORKFLOW.md`, `CONTEXT.md` §Orchestration, `docs/agents/{issue-tracker,triage-labels,automations,planning-stack,signal-up}.md`.

### Team / product

- Workspace product: **KitCollective**; team **Engineering** (`KIT`).  
- Lanes: `development` (integration), `staging`, `production`.  
- Approver: **Nicklas**. Delegate agent name **Cursor** must stay empty on issues (setting Cursor starts Cloud Agent — factory skips).

### Custom workflow states (`factory.config.json` / `linear.setup.json`)

| State | Linear type | Who moves | Meaning |
| --- | --- | --- | --- |
| **Backlog** | backlog | humans, `/to-tickets`, Intake | Dispatch-eligible when `ready-for-agent` + unblocked |
| **Parked** | unstarted | humans; worker Idle timeout | Visible; never auto-dispatched |
| **Implementing** | started | **planner** claim; checker/land fail | Coding / fix loops |
| **In Review** | started | implement after pre-review gate | Checker owns next step |
| **Ready for merge** | started | checker pass | Auto-merge candidate |
| **Merging** | started | Auto-merge or approver | Merge permission; `/land` runs |
| **Done** | completed | **land only** after `gh pr merge` | SHA on integration |
| **Canceled** | canceled | humans | Dead |

Also referenced (team defaults, not in `linear.setup.json` `states` map): **Triage**, **Duplicate** — planner never claims.

**Aliases:** Todo→Parked, In Progress→Implementing, Cancelled→Canceled.

### Labels (who-acts / triage group + others)

Factory who-acts: `ready-for-agent`, `ready-for-human`, `needs-triage`, `needs-info`, `wontfix`, `signal-up`, `proposal`.  
Spec/Type/Work/Surface: `kickoff`, `feature`, `seed`, `surface:{mobile,web,admin,api}`.  
Project craft filters: `craft:design|frontend|backend`.  
**Note:** `factory.config.json` lists `needs-info` and `proposal`; `linear.setup.json` label IDs omit those two (may need re-bootstrap if missing in workspace).

### Transition logic (happy path)

```
Triage/inbox → (Intake/human) → Backlog + ready-for-agent
  → planner → Implementing
  → implement (PR + pre-review gate) → In Review
  → checker pass → Ready for merge
  → Auto-merge or Nicklas → Merging
  → land → Done
```

**Fail / loop:** checker or land fail → **Implementing** (same branch/PR); workpad `### Review feedback` + loop counters; cap 5 CI-fail or 5 reviewLoops blocks Auto-merge.  
**Signal-up:** new Triage issue, label `signal-up` only — never `ready-for-agent`, never Implementing.  
**Dispatch eligibility:** status=`dispatch.state` (Backlog) ∧ `ready-for-agent` ∧ no unresolved `blockedBy` ∧ not `signal-up` ∧ empty Linear Agent ∧ write-scope not overlapping another Implementing issue.

No custom Linear *fields* beyond labels/states documented in setup; automation is PI worker (webhooks/poll) + Desktop skills, not Linear native Agent assignment.

---

## 7. Staging outcome

| Artifact | Absolute path |
| --- | --- |
| Staged skills + MANIFEST + REPORT | `/workspace/harness/staging/skills-from-git-collective/` |
| Working copy for skeleton builder | `/workspace/specs/harness-working-skills/` |
| Staged skill folders | `_shared`, `implement`, `tdd`, `codebase-design`, `diagnosing-bugs`, `code-review`, `land`, `sync-development`, `reap-worktree`, `signal-up`, `issue-session`, `handoff` |
| This report | `/workspace/harness/staging/skills-from-git-collective/REPORT.md` |
| Manifest | `/workspace/harness/staging/skills-from-git-collective/MANIFEST.md` |

**Success criteria:** REPORT.md exists; staging has copied skills; Kit Collective untouched (`git status --porcelain` clean for `.cursor` on Mac SoT).
