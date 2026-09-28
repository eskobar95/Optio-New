# CONTEXT.md — Optio produktkontekst

Kort produkt- og beslutningskontekst for Cursor-agenter. Læs denne fil sammen med [AGENTS.md](AGENTS.md) og [docs/SPEC.md](docs/SPEC.md). Formelle beslutninger: [docs/adr/](docs/adr/).

## Forretning

**Optio** er en **software factory**: et agent-orchestreret system der tager arbejde ind (fx Linear-issues), planlægger, implementerer, reviewer og lander kode via PRs — med menneskelige gates hvor det er nødvendigt.

Målet er ikke et generelt chat-værktøj, men en **gentagelig fabrik** for software-arbejde: samme pipeline, samme politikker, samme observability — på tværs af workspaces og repos.

## Produktbeslutninger

Disse er låst (se ADRs + Linear ENG-22…36):

| Beslutning                       | Valg                                                                                                                                           |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow-UI                      | **Vertical stack** (Zapier-stil), ikke node-canvas (n8n-stil) — [ADR-0001](docs/adr/0001-vertical-stack-over-node-canvas.md)                   |
| Agent/sub-agent/skill-definition | **Form-builder** primary, raw YAML/code toggle — [ADR-0003](docs/adr/0003-form-builder-over-raw-yaml.md)                                       |
| MCP tools                        | **Node-level capabilities** (allow-list i form-builder) — [ADR-0002](docs/adr/0002-capabilities-vs-integrations.md)                            |
| GitHub / Linear / Slack          | **Workflow-/workspace-level integrations** only — aldrig inde i agent-definitionen — [ADR-0002](docs/adr/0002-capabilities-vs-integrations.md) |
| Skill/agent-body                 | **Lazy load**: katalog (name + description) først; fuld body ved select — [ADR-0004](docs/adr/0004-lazy-loading-and-dynamic-skill-pick.md)     |
| Skill-valg ved runtime           | **Jev dynamic skill-pick** per task — ikke hardcoded load-all — [ADR-0004](docs/adr/0004-lazy-loading-and-dynamic-skill-pick.md)               |

## Features v1

- **Agent builder** — sidebar med tabs: Workflows, Agents, Sub-agents, Skills; list + Create new + shared detail shell
- **Sub-agents** — samme UX-mønster som agents (form-builder + files)
- **Skills** — **SKILL.md**-mønster (folder + YAML frontmatter + Markdown body)
- **MCP tools** — catalog entries; toggles under Capabilities på noden
- **Vertical stack** — stages som kompakte rækker (icon, name, status); expand inline
- **Gates** — Approval, Conditional, Retry (default 3), Smart routing
- **Custom mini-agents** — letvægts stage-agent: én MD-fil + model + autonomy/context-toggles (ingen fuld form-builder)
- **Flue sidecar** — separat Compose-container; HTTP `dispatch` / `start`; crash-isolation

## Designvalg

- **Standard UI-komponenter** — ingen custom design system i v1
- **Form-first** med **raw/code toggle** (VS Code settings / Docker Compose-mønster)
- **Multi-format editor** efter node: Markdown (instructions), YAML (config), JSON kun når struktureret data kræves — filtype bestemmes af noden, ikke frit valgt
- Identisk UX på tværs af agent / sub-agent / skill

## Arkitektur

| Lag            | Rolle                                                             |
| -------------- | ----------------------------------------------------------------- |
| **Optio**      | Lifecycle, policy, HITL, Linear intake, BullMQ stages             |
| **Flue**       | Sidecar harness (`dispatch` / `start`); durable implement-session |
| **Jev**        | Router / gates / dynamic skill-pick (ikke Cursor session-model)   |
| **Cursor CLI** | Builder-tool Flue kalder (`useTool`) — ikke factory-owner         |
| **Linear**     | Issues / status (intake) — ikke Agent Sessions                    |
| **BullMQ**     | Queue / stage graph (plan → implement → review → ready → merge)   |

Detaljer: [docs/flue-contract.md](docs/flue-contract.md), [docs/pipeline.md](docs/pipeline.md), [docs/kit-harness.md](docs/kit-harness.md), [AGENTS.md](AGENTS.md).

## Linear (Decisions + implement)

Parent: [ENG-22](https://linear.app/findjobabroad/issue/ENG-22) (vision/architecture).

| Issue                                                   | Emne                                                |
| ------------------------------------------------------- | --------------------------------------------------- |
| [ENG-21](https://linear.app/findjobabroad/issue/ENG-21) | Cursor CLI wrapper                                  |
| [ENG-22](https://linear.app/findjobabroad/issue/ENG-22) | Factory vision & architecture                       |
| [ENG-24](https://linear.app/findjobabroad/issue/ENG-24) | Data model (tenants/workspaces/…)                   |
| [ENG-25](https://linear.app/findjobabroad/issue/ENG-25) | Jev gates & routing                                 |
| [ENG-26](https://linear.app/findjobabroad/issue/ENG-26) | Flue adapter / sidecar (Done)                       |
| [ENG-28](https://linear.app/findjobabroad/issue/ENG-28) | UX/spec: file structure, form-builder, stack, gates |
| [ENG-29](https://linear.app/findjobabroad/issue/ENG-29) | Form-builder implement                              |
| [ENG-31](https://linear.app/findjobabroad/issue/ENG-31) | Workflow vertical stack                             |
| [ENG-32](https://linear.app/findjobabroad/issue/ENG-32) | Root navigation shell                               |
| [ENG-33](https://linear.app/findjobabroad/issue/ENG-33) | Stage module picker & custom agents                 |
| [ENG-34](https://linear.app/findjobabroad/issue/ENG-34) | Gates (approval/conditional/retry/smart routing)    |
| [ENG-35](https://linear.app/findjobabroad/issue/ENG-35) | Data model agents/skills/MCP/workflows              |
| [ENG-36](https://linear.app/findjobabroad/issue/ENG-36) | Flue runtime session binding                        |

Ved konflikt: **Linear Decisions + ADR’er vinder over ældre kode**; SPEC beskriver harness-v1.
