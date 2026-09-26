-- Human approval rows for plan and merge gates (issue #86).
-- Timeout sets status timed_out and does not approve the row.

CREATE TABLE IF NOT EXISTS hitl_approval (
  task_id text NOT NULL,
  session_id text NOT NULL,
  point text NOT NULL CHECK (point IN ('plan', 'merge')),
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'replan', 'timed_out')),
  confidence double precision,
  reason text NOT NULL,
  source text NOT NULL CHECK (source IN ('policy', 'human', 'timeout', 'gate')),
  requested_at timestamptz NOT NULL,
  decided_at timestamptz,
  notified_at timestamptz,
  timeout_at timestamptz NOT NULL,
  PRIMARY KEY (task_id, session_id, point)
);

CREATE TABLE IF NOT EXISTS hitl_signal (
  task_id text NOT NULL,
  session_id text NOT NULL,
  point text NOT NULL CHECK (point IN ('plan', 'merge')),
  confidence double precision NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (task_id, session_id, point)
);
