-- Per-task session artifact trail (plan, PR link, stage outcome, last error).
-- One row per (task_id, session_id, stage). Replays update that row.
-- Retention is enforced by the orchestrator (default 14 days, 16 KiB, 2000 rows)
-- so a CX33 disk is not filled by transcripts or diffs.

CREATE TABLE IF NOT EXISTS session_artifacts (
  task_id text NOT NULL,
  session_id text NOT NULL,
  stage text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('completed', 'failed')),
  body text NOT NULL,
  plan_text text,
  pr_url text,
  error_message text,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (task_id, session_id, stage)
);

CREATE INDEX IF NOT EXISTS session_artifacts_updated_at_idx
  ON session_artifacts (updated_at);
