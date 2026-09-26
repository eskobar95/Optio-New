# Task token and USD caps

Each task has a token cap and a USD cap. Agent steps check the ledger before they run and again after they report usage. Crossing a cap, or failing to report a dimension the cap uses, throws `BudgetExceeded` (`BudgetExceededError`). That error is unrecoverable in BullMQ, the step cursor does not advance, and later stages do not start.

Bookkeeping steps (`ack_session`, `record_*`, `open_pr`, `merge_branch`) are not agent runs. They report zeros and do not spend the cap.

## Defaults

Sized for a Hetzner CX33 box (small VPS) in front of Vercel AI Gateway, which bills pass-through model usage:

| Cap    | Default  | Why                                                                                         |
| ------ | -------- | ------------------------------------------------------------------------------------------- |
| Tokens | `400000` | Cursor CLI baseline context alone is ~15k+; plan/implement/review stage caps leave room for real turns. |
| USD    | `2`      | About one coding pass at Gateway rates for Sonnet-class models, not a month of CX33 credit. |

Per-stage caps in `workflows/default-task.yaml` add up to those totals: plan 40k / $0.40, implement 120k / $1.20, review 20k / $0.20, ready 10k / $0.10, merge 10k / $0.10. Ready and merge have no agent step, so those stage caps apply only if a later agent step is added on that stage.

Raise the task totals in env when a workflow needs a larger slice. Do not raise them to “unlimited”.

## Configuration

Env overrides the task totals in YAML. Stage caps stay in YAML.

| Variable                | Meaning                                  |
| ----------------------- | ---------------------------------------- |
| `OPTIO_TASK_MAX_TOKENS` | input + output tokens for the whole task |
| `OPTIO_TASK_MAX_USD`    | estimated USD for the whole task         |

A blank variable leaves the YAML or the default. A non-numeric value throws at startup. Caps must be `>= 0`. A cap of `0` allows a reported zero and rejects any positive spend.

Tokens are `inputTokens + outputTokens`. Cached tokens are not added again.

## Fail closed

Before an agent step, if the ledger is already over the task cap or that stage’s cap, the handler is not called.

After the step:

- Both token counts are required when a token cap is set. `costUsd` is required when a USD cap is set.
- A missing or negative number is `usage_unreported`, not zero.
- The reported delta is added, then the caps are checked again.

`GET /budget?taskId=&sessionId=` returns `caps`, `usage` (`tokens`, `costUsd`, per-stage totals), and `exceeded`. The same numbers are logged as JSON `msg: task_budget`. The payload has no API key, bearer token, or secret.

## Gateway

Hop 2 deny on the Vercel AI Gateway path is unchanged: `applyHop2Decision` still answers HTTP 429 when the router choice is `deny`, and `reason: budget_exhausted` maps to CodingAgent `budget_exhausted`. The task cap is the orchestrator’s hard stop around that. A Gateway 429 does not raise the task cap, and a task still under its cap does not force the Gateway to allow a `deny`.

See `gateway/jev-router/README.md`.
