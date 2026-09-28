# Flue runtime session binding (ENG-36)

Contract-only note for Optio-side Flue session continuity. Builds on the HTTP contract in [`flue-contract.md`](./flue-contract.md) (ENG-26). Optio owns lifecycle/HITL; Flue is the sidecar harness; Cursor CLI remains a tool Flue calls (not this ticket).

## Roles

| Layer                | Responsibility                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| Optio binding store  | Map `taskId` + stage → `{ flueSessionId, durableConversationId }`                                 |
| Flue adapter         | `dispatch` with resume id when bound; `put` binding on first successful dispatch (before `start`) |
| Flue sidecar         | Return `accepted` (new) or `resumed` (same durable conversation)                                  |
| Review feedback stub | Append structured payload onto the **implement** binding; clear after successful start            |
| Jev skill-pick port  | Injectable stub for lazy skill selection (ENG-25 owns real client); fail-open on throw            |

## Binding key

- Key: `` `${taskId}::${stage}` ``
- Durable implement session stage is always `"implement"`
- Review does **not** create a second implement durable binding; it posts feedback into the implement binding

Types/store: `src/adapters/flue/session-binding.ts` (`FlueSessionBindingStore`, `InMemoryFlueSessionBindingStore`).

### Store injection

- Default: process-scoped in-memory store via `getDefaultFlueSessionBindingStore()` so `createFlueAdapter()` / `createCodingAgent("flue")` recreates keep continuity **within one process**.
- Multi-process / durable workers **must inject** a shared `sessionBinding` (DB-backed later); do not rely on the default across machines.

## Accept vs resume

1. First implement `run` for a task: no binding → `dispatch` without `durableConversationId` → Flue `status: "accepted"` → Optio `put`s binding via `onDispatched` **before** `start`.
2. Pause / approval / retry / second `run` for the same task: binding present → `dispatch` with `durableConversationId` → Flue `status: "resumed"` → same durable id (never cold-start a new conversation for the same implement task).
3. Client re-dispatch after network/5xx still retries **`start` only** once a session is bound (ENG-26). Binding survives a failed `start` so the next `run` resumes.

## Review feedback → implement session

Structured payload (`source: "review" | "gate_retry" | "gate_send_back"`, `summary`, `mustFix[]`, optional `verdict` / `files` / `at`) is appended via `appendReviewFeedback` onto the implement binding (capped at `FLUE_FEEDBACK_MAX_ITEMS`). Gate sources are used by ENG-34 approval send_back / retry so review and gate context stay distinguishable.

On the next implement `dispatch`, `formatAccumulatedFeedback` is merged into `instructions` so retry re-enters Flue with **accumulated context**, not a new task. After a **successful** `start`, feedback is cleared (`clearReviewFeedback`) so the next review cycle starts fresh. No new Flue HTTP endpoint in this stub.

## Jev lazy-load / skill-pick (port only)

`JevSkillPickPort.pickSkills({ taskId, stage, prompt, registry })` is injectable. Default `createPassthroughJevSkillPick()` returns `{ skillIds: [] }` with no network. Adapter **fail-opens** to empty skills if the port throws (soft gate; ENG-25 owns real timeouts).

**Do not** invent a competing `jevClient` here. Real gates, cascade, confidence, and HTTP belong to ENG-25.

## Non-goals

- Real Flue agent loop / cursor-agent I/O (ENG-21)
- Real Jev client or gate sequence (ENG-25)
- Gate UX (ENG-34)
- Schema migration (`durable_conversation_id` already on `flue.sessions` from ENG-24)
- Merge/deploy from this ticket alone
