# Workflow gates (ENG-34)

Runtime contracts for Optio workflow decision points: **approval**, **conditional**, **retry**, and **smart_routing**. These are typed APIs + pure policy helpers that Flue session continuity ([ENG-36](./flue-session-binding.md)) and Jev ([ENG-25](./jev-gates.md)) can call.

**UI is out of scope.** Vertical-stack rows and Optio Glass canvas belong to ENG-28 / ENG-31. Existing plan/merge HITL ([hitl.md](./hitl.md)) is unchanged.

## Kinds

| Kind            | Role                                          | Key outcome                              |
| --------------- | --------------------------------------------- | ---------------------------------------- |
| `approval`      | Pause for human: approve / reject / send_back | Resume same Flue `durableConversationId` |
| `conditional`   | Evaluate stage evidence against presets       | `pass` \| `fail`                         |
| `retry`         | Re-run stage up to N times (default **3**)    | `retry` \| `exhausted` (+ `lastError`)   |
| `smart_routing` | Choose next path via injectable Jev port      | `human_review` \| `auto_continue`        |

Code: `src/orchestrator/gates/` (`evaluateWorkflowGate`, helpers, `InMemoryWorkflowGateStore`).

Distinct from:

- Harness **security** hard gates (`src/harness/gates`)
- Jev soft gate kinds (`backend_cascade`, `skill_pick`, …) in ENG-25

## Approval ↔ Flue (hard rule)

Pause/resume **must** reuse the ENG-36 implement binding:

1. `resumeApproval` / retry path requires `sessionBinding.get(taskId, "implement")` with a non-empty `durableConversationId`.
2. Missing binding → `WorkflowGateError` code `missing_flue_binding` (fail-closed).
3. **Never** invent a new conversation id (no cold-start).
4. `approve` → continue with same id.
5. `reject` → stop; binding is preserved for inspect.
6. `send_back` → `appendReviewFeedback` onto the implement binding, then continue with same id.

## Retry ↔ accumulated context

Each `retry` outcome increments the attempt counter, stores `lastError` for later UI, and appends structured feedback via the ENG-36 review-feedback seam so the next Flue `dispatch` carries context. Exhaustion (`attempt > maxAttempts`) returns `exhausted` / `escalate` without cold-starting a session.

## Conditional presets

| Preset               | Pass when                                                |
| -------------------- | -------------------------------------------------------- |
| `ci_status`          | `evidence.ciStatus === "success"`                        |
| `conflict_check`     | `evidence.hasConflict === false`                         |
| `coverage_threshold` | `coveragePercent >= coverageMinPercent`                  |
| `custom`             | `evidence.customPass === true` (requires `customRuleId`) |

## Smart routing port

```ts
interface JevSmartRoutingPort {
  route(input: SmartRoutingInput): Promise<SmartRoutingResult>;
}
createPassthroughJevSmartRouting(); // auto_continue, no network
```

Default **fail-open** → `auto_continue` if the port throws (set `failOpen: false` to surface the error). Real skill-pick / HTTP remains ENG-25 — do not invent a competing `jevClient` here.

## Store seam

`InMemoryWorkflowGateStore` holds pending approvals and retry counters in-process. Multi-process workers must inject a shared store later; no DB migration in this ticket.

## Non-goals

- Optio Glass / workplace UI / vertical-stack rows
- BullMQ stage-graph rewrite or HITL HTTP changes
- Real Jev client (ENG-25)
- Merge/deploy from this ticket alone
