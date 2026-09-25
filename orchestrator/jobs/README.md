# orchestrator/jobs

BullMQ workers backed by Redis. Durable job steps for workflow.start, step runs, retries, and cancel on session stop.

See `docs/SPEC.md` §11–§12.

## Architectural decision

**BullMQ is the official orchestrator** for the full issue-to-merge pipeline (intake → plan → implement → review → merge). Each stage is a job that waits on the previous stage; crashed jobs resume from durable step state. **Vercel is AI Gateway only** — do not use Vercel Workflows/WDK here. See SPEC §14.0.
