# adapters/cursor

Cursor CLI **headless** CodingAgent adapter. Subscription path only in v1 (`CURSOR_API_KEY` → `https://api2.cursor.sh`). `run()` spawns `agent --print --output-format json` in the worktree. The child env strips `OPENAI_BASE_URL` and any local `CURSOR_API_ENDPOINT`. No model MITM.

Implements the shared `CodingAgent` interface in `../../src/adapters/coding-agent.ts`. Pick it with `resolveCodingBackend({ stepCodingBackend: "cursor" })`.
