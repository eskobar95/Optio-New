-- Per-stage timing, adapter usage, and agent actions (SPEC §12, §13.4).
-- One row per task, session, and pipeline stage. Actions and usage are the
-- operator view for GET /tasks/:taskId/actions.

CREATE TABLE IF NOT EXISTS pipeline_stage_run (
  task_id text NOT NULL,
  session_id text NOT NULL,
  stage text NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  duration_ms integer,
  status text NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  reason text,
  usage jsonb NOT NULL,
  actions jsonb NOT NULL,
  PRIMARY KEY (task_id, session_id, stage)
);

CREATE INDEX IF NOT EXISTS pipeline_stage_run_task_idx ON pipeline_stage_run (task_id);
