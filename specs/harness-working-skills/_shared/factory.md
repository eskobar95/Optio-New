# Factory config (load first)

Every harness skill starts here.

1. Read `factory.config.json` at the repo root. That file is the only product-specific input. A new project copies `factory.config.example.json` → `factory.config.json` and fills it in.
2. Read `WORKFLOW.md` for the control-plane prompt (generic).
3. If `linear.setup.json` is missing, stop and run `/bootstrap-linear`.
4. Role subagents live in `paths.helpers` (default `.cursor/agents/`). v1 roles: Frontend, Backend, DevOps. Spawn by matching the slice to each Role’s YAML `description`. Skip `planner`, `checker`, `release`, and files whose description says they are a deprecated alias. Expo, Nest, and design-system load as Area skills on demand — not as agent ids. Roles never own Linear issues.

Working skills are `.cursor/skills/` — self-contained (Matt’s loop plus this factory). Do not recreate `.agents/`.

Vendored Expo/EAS skills live under `.cursor/skills/expo/`. They are not factory skills. The Expo **Area skill** loads `expo-overview` first, then the matching leaf. Product docs (`CONTEXT.md`, ADRs, `docs/design-system.md`, this Role layer) win on conflict.

Resolve names from config, not from memory:

| Need | Config path |
| --- | --- |
| Team key | `linear.teamKey` |
| Dispatch label | `ready-for-agent` |
| Approver | `approver` |
| Integration branch | `lanes.integration` |
| Dispatch state | `dispatch.state` |
| Claim order | `dispatch.priorityOrder` |
| Signal-up cap | `agent.signalUpCapPerRun` |
| Spec folder | `paths.specs` |
