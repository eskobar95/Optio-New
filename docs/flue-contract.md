# Optio ↔ Flue HTTP contract (ENG-26)

Contract-only note for the Flue sidecar stub. Optio owns lifecycle, policy, and HITL. Flue owns the agent harness loop. Cursor CLI is a **tool Flue calls**, not the factory owner.

## Roles

| Layer        | Responsibility                                      |
| ------------ | --------------------------------------------------- |
| Optio        | Intake, BullMQ stages, HITL, re-dispatch on failure |
| Flue sidecar | Agent loop (`dispatch` / `start`); crash-isolated   |
| Cursor CLI   | `useTool` inside Flue (ENG-21 thin invoke later)    |

## Endpoints

Base URL: `FLUE_BASE_URL` (default `http://127.0.0.1:3220`). Compose profile: `flue`.

| Method | Path        | Purpose                                            |
| ------ | ----------- | -------------------------------------------------- |
| `GET`  | `/health`   | Liveness (`{ ok: true, service: "flue" }`)         |
| `POST` | `/dispatch` | Bind task → Flue session + `durableConversationId` |
| `POST` | `/start`    | Run (or stub-complete) session; return branch / PR |

Typed Zod schemas live in `src/adapters/flue/contract.ts`.

### Dispatch

Request (camelCase JSON): `taskId`, `worktreeId`, `workflowId`, `stepId`, `agentId`, `workspaceRef`, optional `optioWorkspaceId` / `durableConversationId`, `sandboxMode: "local"`, `prompt`, optional `instructions` / `modelId`, `allowedTools`.

Response: `{ sessionId, durableConversationId, status: "accepted" \| "resumed" }`.

### Start

Request: `{ sessionId, durableConversationId, taskId }`.

Response: `{ sessionId, branch, prUrl?, usageEvents[], status, errorClass?, logs? }`.

`usageEvents` map into Optio's `CodingAgentUsage` / adapter usage rows. **v1** returns events in the JSON body. SSE streaming of token events is a later cut.

## Agent shape (future real Flue)

- `useModel` — model for Flue's own loop
- `useSandbox` — `local()` first (no Docker sandbox in v1)
- `useTool` — cursor-agent
- `useMcpConnection` — Linear / GitHub as needed

## Phases (documented; stub skips)

planner → builder specialists → TDD skill (default, Jev-waivable) → CI green. Jev picks specialists in the planner (ENG-25).

## Session continuity

Implement session is durable (`flue.sessions.durable_conversation_id`). Review is a separate session that posts structured feedback to the implement session id. Jev routes minimal fix vs full re-run vs human.

## Failure / re-dispatch

A Flue crash must not take Optio down. The Optio CodingAgent client retries up to **3** attempts on network failure, timeout (`AbortSignal`, default 60s), or HTTP 5xx. After a successful `dispatch`, retries hit **`start` only** (same session) to avoid orphan sessions. HTTP 4xx fails closed without retry.

## Non-goals

- Flue must not replace the Optio orchestrator
- No Docker sandbox in v1
- No full Flue product UI
- No real cursor-agent I/O in this stub (ENG-21)
- No Jev gates in this stub (ENG-25)

## Decisions delta (vs pre-existing Eve code)

- Eve `CodingBackendSchema` already had `sandbox`; this contract **adds** `flue` and keeps `sandbox`.
- Adapter hop-1 ids remain `cursor` / `codex` / `flue` (DB enum uses `cursor-cli` / `flue` / `codex` — catalog naming unchanged).
