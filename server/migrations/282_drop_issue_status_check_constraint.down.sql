-- PPP 282: restore the legacy-only issue.status CHECK constraint that this
-- migration removed. Only safe to apply when every writer submits the legacy
-- lowercase vocabulary; re-adding it after canonical spellings have entered
-- the column would fail. Mirrors the original 001_init definition.
ALTER TABLE public.issue
    ADD CONSTRAINT issue_status_check
    CHECK (status IN ('backlog', 'todo', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled'));

COMMENT ON COLUMN public.issue.status IS NULL;
