-- Per-task token and USD ledger (issue #87). One row per stage.
-- The stage processor sums these rows and fail-closes with BudgetExceeded.

CREATE TABLE IF NOT EXISTS task_usage (
  task_id text NOT NULL,
  session_id text NOT NULL,
  stage text NOT NULL,
  input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cost_usd double precision NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (task_id, session_id, stage)
);
