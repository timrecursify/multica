-- Reverse 275_capture_issue_qc_fail_count.up.sql.
--
-- Drops the persisted QC rework circuit-breaker counter. Only run this after
-- the QC workers stop writing the column; stored counter values are not
-- recoverable.
ALTER TABLE issue
    DROP COLUMN IF EXISTS qc_fail_count;
