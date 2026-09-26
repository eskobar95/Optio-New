-- Durable BullMQ stage cursor (SPEC §14.0).
-- next_step_index is the first intra-stage step that has not been persisted.
-- Requeue continues at that index; completed stages are not run again.

CREATE TABLE IF NOT EXISTS pipeline_step_cursor (
  task_id text NOT NULL,
  session_id text NOT NULL,
  stage text NOT NULL,
  next_step_index integer NOT NULL CHECK (next_step_index >= 0),
  status text NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (task_id, session_id, stage)
);
