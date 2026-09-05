-- Keep checkout timeouts distinct from real inter-ticket dependencies.
ALTER TABLE issue_stage_outcome
  DROP CONSTRAINT IF EXISTS issue_stage_outcome_blocked_on_check;

ALTER TABLE issue_stage_outcome
  ADD CONSTRAINT issue_stage_outcome_blocked_on_check
  CHECK (blocked_on IS NULL OR blocked_on IN ('ci', 'human', 'sha', 'dependency', 'quota', 'checkout'));
