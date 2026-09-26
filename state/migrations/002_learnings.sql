-- Failure fingerprints and thresholded meta-issue drafts (SPEC §10).
-- The learning worker upserts rows. It does not rewrite workflow gates or skill files.

CREATE TABLE IF NOT EXISTS learnings (
  fingerprint text PRIMARY KEY,
  workflow_id text NOT NULL,
  step_id text NOT NULL,
  skill_ids jsonb NOT NULL,
  specialist_ids jsonb NOT NULL,
  error_class text NOT NULL,
  field_tag text NOT NULL,
  occurrences jsonb NOT NULL,
  hit_count integer NOT NULL CHECK (hit_count >= 0),
  status text NOT NULL CHECK (status IN ('observed', 'proposed')),
  excerpt text NOT NULL,
  sample_task_ids jsonb NOT NULL,
  proposal_body text,
  meta_issue_url text,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS learnings_field_tag_updated
  ON learnings (field_tag, updated_at DESC);
