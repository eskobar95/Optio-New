# Optio data model (Drizzle) — ENG-24 + ENG-35

Catalog schemas live under `src/db/schema/` (`optio` + `flue`). Forward migrations are in `drizzle/` — **never edit** an applied migration; only add new ones.

## Schema lock (ENG-24)

See Linear [ENG-24](https://linear.app/findjobabroad/issue/ENG-24) Decisions + Schema lock. That ticket wins on conflict with older assumptions.

Core: tenants, workspaces, users, memberships, agents, skills, workflows, connections (Infisical path refs), stages, Jev gates, transcripts, skill_pick_logs, flue.sessions.

## ENG-35 refinement (agents / skills / MCP / workflows)

Aligns catalog columns with ENG-28 UX + ADR-0002/0004:

| Concern                            | Schema                                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| MCP as **capability**              | `optio.mcp_tools` catalog + `agent_mcp_tools` / `skill_mcp_tools` allow-lists — not workflow integration config     |
| Integrations (GH / Linear / Slack) | `optio.connections` (`kind` github\|linear\|slack\|mcp) + `workflow_connections`; credentials = Infisical path only |
| Lazy-load flags                    | `agents.lazy_load_body`, `skills.lazy_load_body` (default `true`)                                                   |
| SKILL.md ref                       | `skills.body_ref` → SKILL.md path; optional `folder_ref` / `config_ref`                                             |
| Agent form fields                  | `agents.description`, `config_ref`; typed `agent_subagents` allow-list (legacy `tools` / `subagents` jsonb kept)    |
| Ordered vertical stack             | `workflow_stages.sort_order` + `stage_type` + `config` + optional `connection_id`                                   |

`connections.kind=mcp` remains (ENG-24 lock) for vaulted MCP **server** secrets. Form-builder Capability toggles use `mcp_tools`, not connection rows.

## Still open

- Versioning of agent/skill definitions (git refs via `*_ref` for now; DB revision history deferred)
- Cutover of legacy `public.*` runtime tables → Drizzle/`optio`
- Enforce `agent_connections` / `workflow_connections` to github\|linear\|slack only at the application layer (enum still includes `mcp`)
- Jev runtime skill-pick wiring (ENG-25) — schema only here

## Ops

```bash
npm run db:generate   # after schema TS changes
npm run db:migrate    # apply drizzle/
```

Orchestrator boot also runs `runDrizzleMigrations` when `OPTIO_NEW_DATABASE_URL` is set. See [pipeline.md](pipeline.md).
