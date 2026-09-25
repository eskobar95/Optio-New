# Manifest — skills staged from Kit Collective

**Source (SoT):** `/Users/nicklaseskou/Projects/kit-collective/.cursor/skills/`  
**Read-only analysis date:** 2026-09-26 (PT / Europe/Lisbon)  
**Staging:** `/workspace/harness/staging/skills-from-git-collective/`  
**Also copied to:** `/workspace/specs/harness-working-skills/`  
**Kit Collective:** not modified.

## Included (v1 coding-agent harness vertical slice)

| Skill / path | Source absolute path | Phase tag | Rationale |
| --- | --- | --- | --- |
| `_shared/` | `…/.cursor/skills/_shared/` | dependency | Shared factory name resolution (`factory.md`) required by implement/land/issue-session/etc. |
| `implement/` | `…/.cursor/skills/implement/` | implementation | Core Linear-issue implement loop: branch, TDD seams, PR, pre-review gate → In Review. |
| `tdd/` | `…/.cursor/skills/tdd/` | implementation | Red-green at spec seams; Role helper spawn contract used by implement. |
| `codebase-design/` | `…/.cursor/skills/codebase-design/` | implementation | Deep-module / seam vocabulary shared by tdd + implement. |
| `diagnosing-bugs/` | `…/.cursor/skills/diagnosing-bugs/` | implementation | Repro loop before coding when implement hits a hard blocker. |
| `code-review/` | `…/.cursor/skills/code-review/` | review | Standards / Spec / Slop axes for checker and isolated Desktop review. |
| `land/` | `…/.cursor/skills/land/` | merge / git | Merge PR into integration lane when status is Merging; Done only after merge. |
| `sync-development/` | `…/.cursor/skills/sync-development/` | git | Safe ff-only sync of local integration lane with origin. |
| `reap-worktree/` | `…/.cursor/skills/reap-worktree/` | git | Post-land worktree/branch hygiene. |
| `signal-up/` | `…/.cursor/skills/signal-up/` | meta | Out-of-scope findings → Triage+signal-up instead of PR expansion. |
| `issue-session/` | `…/.cursor/skills/issue-session/` | meta / orchestration | Desktop pipeline: implement → isolated review → land (batch capable). |
| `handoff/` | `…/.cursor/skills/handoff/` | meta | Portable session handoff at phase boundaries. |

## Explicitly excluded from v1 (kept in Kit Collective only)

- **Planning stack:** `grill-with-docs`, `to-spec`, `to-tickets`, `to-design`, `bootstrap-linear` — product kickoff, not coding-agent harness core.
- **Area / product:** `area-*`, `seed-run`, `to-video-brief` — Kit Collective domain.
- **Vendor Expo/EAS tree:** `.cursor/skills/expo/**` (25 skills) — product mobile stack.
- **Optional / later:** `ask-me`, `create-new-skill`, `wait-what`, `prototype`, `research`, `wizard`, `improve-codebase-architecture`.

## Copy integrity

Folders copied intact (`SKILL.md` + siblings: `agents/`, `references/`, `scripts/`, companion `.md`). AppleDouble `._*` junk from macOS tar stripped on the box.
