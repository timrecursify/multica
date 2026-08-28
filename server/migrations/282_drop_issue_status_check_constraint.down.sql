-- PPP-22989 rollback: restore exact pre-up values from the migration sidecar.
ALTER TABLE issue DROP CONSTRAINT IF EXISTS issue_status_check;

-- Restore the pre-282 implicit write vocabulary alongside the data snapshot.
ALTER TABLE issue ALTER COLUMN status SET DEFAULT 'todo';

UPDATE issue i
SET status = r.previous_status
FROM issue_status_282_rollback r
WHERE i.id = r.issue_id;

-- Rows without a sidecar entry were written while the canonical constraint was
-- active. Keep canonical values legal in the legacy vocabulary unchanged
-- (in_progress, in_review); map every other canonical value deterministically.
UPDATE issue i
SET status = CASE status
    WHEN 'Spec' THEN 'backlog'
    WHEN 'Queue' THEN 'todo'
    WHEN 'Human Review' THEN 'blocked'
    WHEN 'Done' THEN 'done'
    WHEN 'Cancelled' THEN 'cancelled'
    WHEN 'Archived' THEN 'cancelled'
    ELSE status
END
WHERE NOT EXISTS (
    SELECT 1
    FROM issue_status_282_rollback r
    WHERE r.issue_id = i.id
);

-- The restored legacy constraint includes its original vocabulary plus every
-- exact pre-up value restored above. quote_literal prevents an old status from
-- changing this DDL; the static legacy values keep the old write vocabulary.
DO $$
DECLARE
    allowed_statuses TEXT;
BEGIN
    SELECT string_agg(quote_literal(status), ', ' ORDER BY status)
    INTO allowed_statuses
    FROM (
        SELECT status FROM issue
        UNION
        SELECT unnest(ARRAY[
            'backlog', 'todo', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled'
        ]::TEXT[])
    ) AS allowed(status);

    EXECUTE
        'ALTER TABLE issue ADD CONSTRAINT issue_status_check CHECK (status IN (' ||
        allowed_statuses ||
        '))';
END $$;

DROP TABLE issue_status_282_rollback;
