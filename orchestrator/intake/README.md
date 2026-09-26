# orchestrator/intake

**New Bot** (Grok Bot) is the decision and intake layer for Optio-New.

## Role

- Accept tasks from chat/API (New Bot), not from Linear Agent Sessions.
- Enqueue BullMQ jobs for the default pipeline: plan → implement → review → ready → merge (`enqueueIntakePipeline` in `src/orchestrator/jobs/`).
- Surface elicitations and status back to New Bot / the human in chat.

## Explicitly out (v1)

- Linear webhooks, GraphQL, OAuth agent scopes, Agent Activities.
- Backlog polling of any issue tracker as the control plane.

## Optional later

HTTP intake webhook (Caddy `/webhooks/*`) for New Bot / CI to enqueue work. Signature verification still required if exposed publicly.

See `docs/SPEC.md` §8 (intake) and §14.0 (BullMQ).
