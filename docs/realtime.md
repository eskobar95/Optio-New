# Realtime live-status wire contract (ENG-40)

Transport + typed event contract for live agent runs. One connection per window,
multiplexed across channels, snapshot + delta resume, and explicit backpressure.
The **same** event schema is used by cloud WebSocket and by local Tauri IPC, so the
renderer normalizes both into one stream.

Module: `src/realtime/`. It is deliberately **separate** from HTTP/intake and from
transcript persistence — see [Streaming ≠ persistence](#streaming--persistence).

## Topology

| Concern    | Decision                                                                    |
| ---------- | --------------------------------------------------------------------------- |
| Primary    | WebSocket (WSS), bidirectional                                              |
| Per window | **one** socket per browser tab / Tauri window — never one per session       |
| Multiplex  | client subscribes to channels; unsubscribe on tab close                     |
| Fallback   | SSE, server → client, **status subset only**                                |
| Fan-out    | Redis pub/sub or NATS between API nodes (port is injectable; stub in tests) |
| Not now    | long polling, gRPC streaming, WebTransport as SoT                           |

Channel ids (`src/realtime/channels.ts`):

- `session:<id>`
- `workspace:<id>`
- `system:status`

`workspace:*` and `system:status` subscriptions receive all active runs via the
snapshot store; `session:*` receives only that session.

## Wire format

JSON over text frames. Every frame has a `type`. Client → server frames are
validated as a discriminated union; server → client frames share
`OutboundFrameSchema` (`src/realtime/types.ts`). Encode/decode lives in
`src/realtime/framing.ts`.

### Server → client live events

All live events carry `type`, `seq`, `channel`, `ts`, and a small `payload`:

| Type         | Payload (max sizes)                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------- |
| `run.token`  | `runId`, `sessionId`, `text` (≤4096), optional `role`                                             |
| `run.tool`   | `runId`, `sessionId`, `toolCallId`, `name`, `phase` (`start`/`progress`/`end`), `summary` (≤1024) |
| `run.status` | `runId`, `sessionId`, `status`, optional `reason`                                                 |
| `run.error`  | optional `runId`/`sessionId`, `code`, `message`                                                   |
| `heartbeat`  | `ts`                                                                                              |
| `snapshot`   | `lastSeq`, `activeRuns[]`, `channels[]`                                                           |

**Never** a full transcript per tick. Large payloads travel as an id/URL and the
client fetches on demand.

### Server → client control frames

`subscribe.ack` (`channels`, `lastSeq`), `unsubscribe.ack` (`channels`), `pong`
(`ts`), `auth.ack` (optional `expiresAt`), `error` (`code`, `message`, optional
HTTP-like `status`).

### Client → server control frames

`subscribe` (`channels`, optional `lastSeq`), `unsubscribe` (`channels`),
`catchup` (`lastSeq`, optional `channels`), `ping` (optional `ts`), `auth`
(`token`), `cancel_run` (`runId`, `sessionId`), `tab_focus` (`focused`, optional
`statusOnly`).

Example:

```json
{ "type": "subscribe", "channels": ["session:s-1", "system:status"], "lastSeq": 41 }
```

```json
{
  "type": "run.token",
  "seq": 42,
  "channel": "session:s-1",
  "ts": 1759000000000,
  "payload": { "runId": "r-1", "sessionId": "s-1", "text": "Hel" }
}
```

## Snapshot + delta resume

Reconnect and tab resume must not reset the UI:

1. On (re)connect the client sends `subscribe` with its `lastSeq`.
2. Server replies `subscribe.ack`, then a `snapshot` (`lastSeq` + active runs).
3. Server then replays only deltas with `seq > lastSeq` from the catchup ring
   buffer (`CATCHUP_BUFFER_SIZE`, default 2048).
4. If the cursor fell out of the buffer, the server marks a **gap** and sends a
   fresh snapshot before deltas. Catchup avoids full replay.

`SequenceClock` allocates strictly monotonic 1-based `seq`; `CatchupBuffer`
retains only lightweight events, never transcripts.

## Backpressure

Per-socket bounded outbound queue (`OUTBOUND_QUEUE_CAP`, default 1000).
Policy (`src/realtime/backpressure.ts`):

- Consecutive `run.token` frames for the same run + channel **coalesce**.
- Under capacity pressure **tokens and expendable frames (heartbeat) are dropped**.
- `run.status`, `run.error`, `error`, `snapshot`, and acks are **critical** and are
  never dropped — the queue evicts an expendable frame to make room.
- Counters (`tokensDropped`, `tokensCoalesced`, `criticalForced`, `depth`) are
  exposed for metrics.

Coalesce window `TOKEN_COALESCE_WINDOW_MS` (default 32 ms) targets 16–50 ms.

## Connection lifecycle

| Knob               | Value                                                     |
| ------------------ | --------------------------------------------------------- |
| Heartbeat interval | 20–30 s (`HEARTBEAT_INTERVAL_MS` = 25 s)                  |
| Idle timeout       | 60–90 s (`IDLE_TIMEOUT_MS` = 75 s); must exceed heartbeat |
| Reconnect backoff  | exponential + full jitter, 0.5 s → 30 s cap               |
| On 401             | **stop** the reconnect loop and force re-login            |

The server sends `heartbeat` on `system:status`; any inbound frame (including
`pong`) resets the idle clock. The client source (`src/realtime/client.ts`)
tracks `lastSeq`, auths on open, subscribes with catchup, and reconnects with
backoff.

### Auth

Short-lived token supplied at connect (query or first `auth` frame), validated
through the injectable `AuthPort`. `status: 401` — whether from a close or an
`error` frame — stops the client loop (`shouldStopReconnect`). No secrets, team
IDs, or model names are hardcoded; ports are injected.

## SSE fallback

`src/realtime/sse.ts` is a server → client read-only path for when WSS is blocked.
It carries **only** `run.status`, `run.error`, `heartbeat`, `snapshot` — never
`run.token` / `run.tool`. Frames reuse the same schema, so the UI renders them
identically. `SseStatusSource` has no reconnect loop of its own; retry WS first.

## Streaming ≠ persistence

The realtime layer is intentionally fast and small. Transcript persistence and
compaction are **out of band**: a parallel consumer (ENG-24) writes the same
events to Postgres. That consumer is **not** in the WS hot path, and the live UI
must never depend on the DB being synchronous per token.

## Dual-path sessions

| Origin         | Transport                     | Notes                                 |
| -------------- | ----------------------------- | ------------------------------------- |
| Cloud sessions | WebSocket (WSS), SSE fallback | fan-out, snapshot+delta, backpressure |
| Local MonoCode | Tauri native IPC/events       | no WS, no network round-trip          |

Both emit the **same** typed events. A local session must never double-stream the
same bytes over both IPC and WS. `LiveSocketEventSource` (WS) and
`TauriLiveEventSource` (IPC) expose the same `LiveEventDispatcher`, so the
renderer consumes one `LiveEventSource`.

## Observability (follow-up, not core)

Active WS connections, events/sec, per-socket queue depth, reconnect rate, and
end-to-end latency (server event → UI render) — to be added as metrics after the
transport lands. See [observability.md](observability.md).

## Tests

`tests/realtime-*.test.ts` cover framing, channels, seq/catchup, backpressure,
multiplex subscribe/unsubscribe, heartbeat/idle, reconnect policy, the client
sources, and the SSE fallback. Run `npm test` and `npm run typecheck`.
