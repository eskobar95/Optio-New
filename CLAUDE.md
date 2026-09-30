# optio-factory

Server-side software factory (was Optio-New). Workspace rules and context: `../CLAUDE.md` and `../docs/context/`.

- Read `AGENTS.md` (roles, layout, pipeline), `CONTEXT.md` (product decisions, Danish), `MAP.md` (path to SPEC section), `docs/SPEC.md`.
- Permission tiers are the outer ceiling (`docs/permission-tiers.md`). Jev gates are soft and fail open (`docs/jev-gates.md`).
- Schema: Drizzle in `src/db/schema/`, raw SQL in `state/migrations/`. Never edit an applied migration.
- Checks: `npm run ci`. Three tests fail on the Mac for unrelated reasons (see skill `optio-verify`).
- Git repo `eskobar95/Optio-New` (branch `main`, 143 commits). The `src/adapters/optio-run` backend is uncommitted. Back up before any rename or move.
