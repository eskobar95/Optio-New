# Cursor CLI in-loop wrapper (ENG-21)

Thin control surface around the Cursor CodingAgent spawn path (`createCursorAdapter` → `agent --print`). Ports sit **between turns / before spawn**, not only in an outer router. Defaults are passthrough so happy-path output matches the pre-wrapper adapter.

## Ports

| Port               | Responsibility                                                                                 | Default                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `CompactionPort`   | Truncate oversized **tool** payloads in a transcript. Never rewrite `user` / `assistant` text. | Truncate tool content above `DEFAULT_TOOL_RESULT_MAX_CHARS` (4000) |
| `WardenPort`       | Gate before shell / write / edit (from `allowed_tools`). `{ allow, reason }`.                  | Always allow (`passthrough`)                                       |
| `SkillMcpPickPort` | Inject skill / MCP server list before spawn.                                                   | Empty lists → prompt unchanged                                     |
| `DecisionPort`     | Future Jev hook. Soft timeout (default 50 ms) or throw → **passthrough**. No HTTP in v1.       | Immediate `{ type: "passthrough" }`                                |

Source: [`src/adapters/cursor/wrapper.ts`](../src/adapters/cursor/wrapper.ts). Wire-in: [`src/adapters/cursor/index.ts`](../src/adapters/cursor/index.ts) via `CursorAdapterDeps.wrapper`.

## Flow

1. Existing `authorizeAgentRun` + `CURSOR_API_KEY` checks (unchanged).
2. `prepareCursorInvoke`: DecisionPort (pick) → `SkillMcpPickPort` → append hint only if non-empty → **one** DecisionPort warden call for all mutation tools (else local `WardenPort` per tool).
3. Warden deny → `permissionDeniedRun` (`error_class: permission_denied`), CLI not started.
4. `invokeCli` with the (possibly annotated) prompt; subscription path stays `CURSOR_API_KEY` → `https://api2.cursor.sh`.
5. `compactCliStdout`: if stdout JSON has a `turns` array, run DecisionPort (compact) / `CompactionPort` and rewrite those turns only. Normal Cursor result JSON has no `turns` → stdout unchanged.

Mid-run tool gates inside the Cursor process need ENG-27 MCP. This stub only exposes the port surface, pre-spawn hooks, and optional post-CLI transcript compaction.

## Injecting ports

```ts
createCursorAdapter({
  wrapper: {
    warden: { gate: () => ({ allow: false, reason: "blocked" }) },
    pick: { pick: () => ({ skills: ["tdd"], mcpServers: [] }) },
  },
  wrapperDecisionTimeoutMs: 50,
});
```

`createCodingAgent("cursor", deps)` accepts the same `CursorAdapterDeps`.

## Measuring token reduction later

Out of scope for this PR (no live eval). When Jev drives compaction:

1. Capture the same task transcript **before** compaction (raw tool payloads) and **after** `applyCompaction` / `CompactionPort.compact`.
2. Compare total characters (or tokenizer counts) of `role: "tool"` turns only; user/assistant must be equal.
3. Optionally log `input_tokens` from Cursor JSON usage on two otherwise identical runs (wrapper on vs off). Prefer fixture transcripts over paid live runs for CI.

## Out of scope

- Real Jev client / ENG-25 gate sequence
- ENG-27 MCP mid-run server
- Flue HTTP loop / sidecar changes
- Multi-tenant UI

Related: ENG-22 (parent), ENG-25, ENG-26, ENG-27.
