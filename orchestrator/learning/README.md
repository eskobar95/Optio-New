# orchestrator/learning

Failure fingerprints → Postgres table `learnings`; thresholded GitHub meta-issues (`meta/self-improve`).

Runnable worker: `src/orchestrator/learning/`. Queue: `optio.learn`. Compose profile: `learn`.

The worker never rewrites production gates, workflow YAML, or skill files. The planner reads the stored recommendation. See `docs/learning-worker.md` and SPEC §10.
