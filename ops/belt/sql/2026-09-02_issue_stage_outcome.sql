-- GSP-1826: typed stage outcomes. Additive; no existing table or trigger changes.
-- Apply after Sol-low QC (risk path: migration). Rollback: DROP TABLE issue_stage_outcome.
CREATE TABLE IF NOT EXISTS issue_stage_outcome (
  issue_id    uuid        NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
  stage       text        NOT NULL,
  outcome     text        NOT NULL CHECK (outcome IN ('ADVANCED', 'BLOCKED', 'NO_OP', 'FAILED')),
  blocked_on  text        NULL     CHECK (blocked_on IS NULL OR blocked_on IN ('ci', 'human', 'sha', 'dependency', 'quota')),
  task_id     uuid        NULL,
  input_hash  text        NULL,
  outcome_at  timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (issue_id, stage)
);
CREATE INDEX IF NOT EXISTS issue_stage_outcome_task_idx ON issue_stage_outcome (task_id);
