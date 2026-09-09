ALTER TABLE issue_stage_outcome
  ADD COLUMN IF NOT EXISTS denial_reason text,
  ADD COLUMN IF NOT EXISTS denial_input_hash text,
  ADD COLUMN IF NOT EXISTS denial_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS denial_next_retry_at timestamptz,
  ADD COLUMN IF NOT EXISTS denial_terminal boolean NOT NULL DEFAULT false;
