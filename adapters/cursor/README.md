# adapters/cursor

Cursor CLI **headless** CodingAgent adapter. Subscription path only in v1 (`CURSOR_API_KEY` → `https://api2.cursor.sh`). `run()` spawns `agent --print --output-format json` in the worktree. The child env strips `OPENAI_BASE_URL` and any local `CURSOR_API_ENDPOINT`. No model MITM.

Implements the shared `CodingAgent` interface in `../../src/adapters/coding-agent.ts`. Pick it with `resolveCodingBackend({ stepCodingBackend: "cursor" })`.

On implement steps (`implementation`, `invoke_implementation`) the prompt gains `CURSOR_IMPLEMENT_ACI_POLICY`: syntax-check each edit and roll a failed edit back, truncate search and list results, and report an empty successful command as `Command succeeded with no output.` That policy stays inside this adapter. Codex does not receive it. Details: [docs/cursor-implement-feedback.md](../../docs/cursor-implement-feedback.md).
