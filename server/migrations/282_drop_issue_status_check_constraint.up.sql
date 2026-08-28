-- PPP-22989: reconcile the issue.status storage layer with the runtime status
-- vocabulary.
--
-- The 001_init migration attached a CHECK constraint that only admits the
-- legacy lowercase spellings (backlog/todo/in_progress/in_review/done/
-- blocked/cancelled). Multica's two boards ran mutually exclusive status
-- vocabularies; the canonical board set (Spec, Queue, in_progress, in_review,
-- Human Review, Done, Cancelled, Archived) is what the production PPP board
-- displays and stores, so the legacy-only CHECK made the DB reject exactly
-- the canonical values the validator's own storage layer must accept — the
-- validator/storage contradiction this ticket resolves.
--
-- Dropping the CHECK never rejects a value it previously accepted; it only
-- eases the set the column may hold. Validation authority moves to the
-- application contract (ConfiguredIssueStatusContract in the handler), which
-- invalidates unknown / wrong-case values with a 400 before any write. The
-- DB trigger trg_canonical_status (bridge migration 010) remains the
-- compatibility net for intake paths that bypass the application validator.
ALTER TABLE public.issue DROP CONSTRAINT IF EXISTS issue_status_check;

COMMENT ON COLUMN public.issue.status IS
  'Issue lifecycle stage. Validated and canonicalized by the application at
   the selected profile (MULTICA_ISSUE_STATUS_PROFILE); no DB CHECK constraint
   so canonical board spellings (Spec, Queue, in_progress, in_review, Human
   Review, Done, Cancelled, Archived) are not rejected at persistence.';
