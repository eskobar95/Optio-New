# Jev MCP — mid-run soft gates (ENG-27)

Expose Jev as a **stdio MCP server** so Cursor CLI sessions can _optionally_ call soft mid-run tools. This is not a hard gate and does not replace Optio policy or the ENG-21 wrapper warden.

## Soft vs hard

| Layer                 | Enforcement                                                          | Location                                    |
| --------------------- | -------------------------------------------------------------------- | ------------------------------------------- |
| **ENG-27 Jev MCP**    | Soft — agent must choose to call the tool; timeout → **passthrough** | This server (`jev_evaluate` / `jev_decide`) |
| **ENG-25 soft gates** | Soft — fail-open (e.g. backend cascade)                              | `gateway/jev-router/gates/`                 |
| **ENG-21 warden**     | Hard — deny before shell/write/edit                                  | `src/adapters/cursor/wrapper.ts`            |
| **Optio hard gates**  | Hard — deterministic HITL / budget                                   | Orchestrator / harness gates                |

Cursor mid-run tools inside the agent process need this MCP. The ENG-21 wrapper only covers pre-spawn / between-turn ports (see [cursor-wrapper.md](cursor-wrapper.md)).

## Tools (tiny schemas)

| Tool           | Purpose                                                                           | Soft outcomes                            |
| -------------- | --------------------------------------------------------------------------------- | ---------------------------------------- |
| `jev_evaluate` | Assess continue vs escalate, next file, or tests green enough                     | `evaluated` \| `passthrough`             |
| `jev_decide`   | Pick an action: `continue` \| `escalate` \| `pick_file` \| `run_tests` \| `defer` | `decided` \| `escalate` \| `passthrough` |

Input (both tools):

```json
{
  "kind": "continue_vs_escalate" | "next_file" | "tests_green_enough",
  "state": { "task_id?", "step_id?", "file_path?", "summary?" },
  "timeoutMs?": 30000,
  "minConfidence?": 0.7
}
```

Shared client: `createJevClient` — model **`jev-1.13.0`**, `POST /v1/systemone`. Transport errors and low confidence map to **passthrough** (fail-open).

## When Cursor CLI should call

Call mid-run when the agent is unsure and a cheap soft signal helps, for example:

- Before a large edit: `continue_vs_escalate`
- Choosing the next file: `next_file`
- After a flaky test run: `tests_green_enough`

Do **not** treat a missing call or `passthrough` as a block. Do **not** use this as a substitute for the warden on shell/write.

## Run

```bash
npm run jev-mcp
```

stdio MCP (Content-Length JSON-RPC). Protocol on **stdout**; diagnostics on **stderr**.

Example Cursor MCP config (follow-up wiring; adapter spawn is not owned by this PR):

```json
{
  "mcpServers": {
    "optio-jev": {
      "command": "npm",
      "args": ["run", "jev-mcp"],
      "cwd": "/path/to/Optio-New"
    }
  }
}
```

## Telemetry

Each tool call records Optio’s reserved span `jev.decision` (`CANONICAL_SPAN.jevDecision`) via `createOtelJevMcpTelemetry` — same OTel path as the rest of the harness. No second logging client.

## Related

- [jev-gates.md](jev-gates.md) — ordered factory soft gates (ENG-25)
- [cursor-wrapper.md](cursor-wrapper.md) — hard in-loop wrapper (ENG-21)
- Code: `gateway/jev-router/mcp/`, CLI: `src/jev-mcp/main.ts`
