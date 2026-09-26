# AGENTS.md — how agents work in Optio-New

**Language:** TypeScript (Node 20+, ESM, strict `tsc`).  
**Decision layer:** **New Bot** (Grok Bot / Cursor agent) — not Linear.  
**Pipeline orchestrator:** **BullMQ** on Redis (SPEC §14.0).

## Roles

| Layer                    | Responsibility                                                                                                               |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| **New Bot**              | Intake and decisions: what to build, when to pause/advance, human elicitation in chat. Enqueues work; no Linear API.         |
| **BullMQ workers**       | Own the job graph: plan → implement → review → ready → merge. Resume after crashes.                                          |
| **Eve phase agents**     | `agents/planner`, `implementation`, `review`, `ready`, `merge` — contracts (`agent.ts` + `instructions.md`).                 |
| **Specialists**          | Thin roles in `.cursor/agents/` (frontend, backend, devops, database). Loaded on demand.                                     |
| **Skills**               | Full bodies in `.cursor/skills/` (SoT). Indexed by `skills/index.json`. Use `bot-session` instead of Linear `issue-session`. |
| **CodingAgent adapters** | `src/adapters/cursor`, `src/adapters/codex` — mutate the worktree only; do not advance the workflow.                         |

## Source layout

- `src/` — TypeScript harness code (intake, jobs, adapters, gateway types).
- `agents/` — Eve phase contracts (markdown + thin TS stubs).
- `tests/` — unit/smoke tests (`tsx --test`).
- `docs/` — SPEC and design docs.
- `.cursor/skills`, `.cursor/agents` — in-repo Cursor SoT.
- `workflows/default-task.yaml` — stage graph.
- `orchestrator/*/README.md` — domain notes; runnable TS for intake/jobs lives under `src/orchestrator/`.

## Adding a task

1. New Bot accepts intent (chat) or optional HTTP intake (`orchestrator/intake`).
2. Validate with `buildIntakeJob` → enqueue BullMQ job.
3. Workers run Eve stages; New Bot gates ambiguous steps.
4. GitHub PR/CI signals feed ready/merge; worktree cleaned after merge.

## Do not

- Integrate Linear webhooks, GraphQL, Agent Sessions, or Linear status vocabulary.
- Commit secrets (`.env`, real API keys).
- Modify `~/Projects/optio` or `kit-collective` from this repo.
- Let adapters own workflow advancement or worktree lifecycle.
- Dump the entire skill library into context — load selectively per step.

## Request-response loop

`runAgentLoop` (`src/agent/loop.ts`) is one New Bot turn. It resolves a skill budget, then calls the model adapter, then returns the response text. Excerpts travel on `ModelRequest.skills`. Tests may inject a mock `SkillLoader`; the default loader reads this repo.

Activation (`src/agent/skills.ts`, `createInstalledSkillLoader`):

1. Read `.cursor/skills/<id>/SKILL.md` and `.cursor/agents/<id>.md`. No parallel copies.
2. Always load `bot-session`, unless `skillBudget.allowedIds` omits it.
3. Add other Kit Collective skills and specialists only when the prompt shares an id token, or a word of 4+ characters, with that file's frontmatter description. Full bodies are not scanned, so a generic prompt does not pull the library in.
4. Stop at `maxSkills` (default **4**) and `maxExcerptChars` (default **2000**, shared across excerpts).
5. Caveman (`.cursor/skills/caveman/SKILL.md`) stays **off** unless `caveman: true` or the prompt contains `/caveman` and not `/caveman off`. Other `caveman-*` skills are not loaded here.

## Local agent loop

```bash
npm install          # installs Husky pre-commit
npm run typecheck
npm test
npm run smoke
```

CI (`.github/workflows/ci.yml`) runs the same checks on every push and every PR to `main`.

## Optional: Caveman (cost / brevity)

- Skills: `.cursor/skills/caveman*` (MIT). Activate with `/caveman`; disable with `/caveman off`. Default **off** — do not force caveman-speak on every agent. `runAgentLoop` follows the same switch and loads only `caveman`, not the other `caveman-*` skills.
- Local proxy: `CAVEMAN_PROXY_ENABLED` (default `false`). See `src/proxy/README.md`. Do not require Caveman Cloud/Platform in V1.
