# adapters/cursor

Cursor CLI **headless** CodingAgent adapter. Subscription path only in v1 (`CURSOR_API_KEY` → `https://api2.cursor.sh`). `run()` spawns `agent --print --output-format json` in the worktree. The child env strips `OPENAI_BASE_URL` and any local `CURSOR_API_ENDPOINT`. No model MITM.

Implements the shared `CodingAgent` interface in `../../src/adapters/coding-agent.ts`. Pick it with `resolveCodingBackend({ stepCodingBackend: "cursor" })`.

The Compose orchestrator image (`Dockerfile.orchestrator`, Debian bookworm) bakes the glibc `agent` binary onto `PATH` from `https://cursor.com/install`. `CURSOR_API_KEY` is not in the image. Compose injects it. `CURSOR_AGENT_BIN` overrides the command when set.

`OPTIO_CURSOR_SANDBOX=disabled` or `allowlist` (set in that image and in Compose) rewrites the tier sandbox to `--sandbox disabled` and keeps `--force` when the tier already adds it. Docker AppArmor cannot start Cursor's user-namespace sandbox. When the variable is unset, `cursorSandboxArgs` stays in effect: read-only is `--sandbox enabled`, edit-worktree and git-push are `--sandbox enabled --force`, and host-admin is `--force` with no sandbox flag.

On implement steps (`implementation`, `invoke_implementation`) the prompt gains `CURSOR_IMPLEMENT_ACI_POLICY`: syntax-check each edit and roll a failed edit back, truncate search and list results, and report an empty successful command as `Command succeeded with no output.` That policy stays inside this adapter. Codex does not receive it. Details: [docs/cursor-implement-feedback.md](../../docs/cursor-implement-feedback.md).

ENG-21 adds optional in-loop wrapper ports (compaction / warden / skill-MCP pick / DecisionPort stub) before CLI spawn. Passthrough defaults leave the happy path unchanged. Details: [docs/cursor-wrapper.md](../../docs/cursor-wrapper.md).
