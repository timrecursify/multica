ALTER TABLE issue_stage_outcome
  DROP COLUMN IF EXISTS denial_terminal,
  DROP COLUMN IF EXISTS denial_next_retry_at,
  DROP COLUMN IF EXISTS denial_attempts,
  DROP COLUMN IF EXISTS denial_input_hash,
  DROP COLUMN IF EXISTS denial_reason;
