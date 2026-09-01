-- One-off recovery. Review the count before running the UPDATE in production.
-- Metadata keys written by processParkedDiagnoses: parked_release_once, parked_release_at.
WITH candidates AS (
  SELECT t.id
    FROM agent_task_queue t
    JOIN issue i ON i.id = t.issue_id
   WHERE t.context->>'diagnosis_processed' = 'true'
     AND i.metadata ? 'parked_release_once'
     AND i.metadata ? 'parked_release_at'
     AND i.status = 'Parked'
)
SELECT count(*) AS affected_rows FROM candidates;

WITH candidates AS (
  SELECT t.id
    FROM agent_task_queue t
    JOIN issue i ON i.id = t.issue_id
   WHERE t.context->>'diagnosis_processed' = 'true'
     AND i.metadata ? 'parked_release_once'
     AND i.metadata ? 'parked_release_at'
     AND i.status = 'Parked'
)
UPDATE agent_task_queue t
   SET context = t.context - 'diagnosis_processed'
  FROM candidates c
 WHERE t.id = c.id
RETURNING t.id;
