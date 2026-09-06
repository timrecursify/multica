-- PPP-23670: make the status contract safe for rolling backend upgrades.
--
-- Runtime migration 282_schema_recon_ppp_parity already occupies the 282
-- migration slot on NOC2.  This migration therefore uses a new, immutable
-- version and widens the existing constraint instead of replaying either
-- historical 282 migration.  Existing relay spellings remain readable while
-- all accepted aliases are normalized on new writes.

ALTER TABLE issue DROP CONSTRAINT IF EXISTS issue_status_check;

CREATE OR REPLACE FUNCTION normalize_issue_status_before_write()
RETURNS TRIGGER AS $$
BEGIN
    NEW.status := CASE NEW.status
        WHEN 'todo' THEN 'Spec'
        WHEN 'backlog' THEN 'Spec'
        WHEN 'Registered' THEN 'Spec'
        WHEN 'Building' THEN 'in_progress'
        WHEN 'In Progress' THEN 'in_progress'
        WHEN 'QC' THEN 'in_review'
        WHEN 'In Review' THEN 'in_review'
        WHEN 'blocked' THEN 'Human Review'
        WHEN 'Blocked' THEN 'Human Review'
        WHEN 'done' THEN 'Done'
        WHEN 'cancelled' THEN 'Cancelled'
        WHEN 'dead_letter' THEN 'Cancelled'
        ELSE NEW.status
    END;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS issue_status_normalize_before_write ON issue;
CREATE TRIGGER issue_status_normalize_before_write
BEFORE INSERT OR UPDATE OF status ON issue
FOR EACH ROW EXECUTE FUNCTION normalize_issue_status_before_write();

-- Keep the ten spellings already present on the GSP board and add the two
-- lower-case canonical values emitted by IssueStatusContract.  The trigger
-- above converts aliases before this constraint runs.
ALTER TABLE issue ADD CONSTRAINT issue_status_check CHECK (status IN
    ('Registered', 'Spec', 'Queue', 'In Progress', 'in_progress',
     'In Review', 'in_review', 'Human Review', 'CI/CD & Deploy', 'Done',
     'Archived', 'Cancelled')) NOT VALID;
ALTER TABLE issue VALIDATE CONSTRAINT issue_status_check;
ALTER TABLE issue ALTER COLUMN status SET DEFAULT 'Spec';
