-- GSP-2595 read-only repair candidate report. The repair is in
-- gsp-2595-repair.sql and must be seat-reviewed; this file never mutates data.
-- Run with default_transaction_read_only=on. This statement does not mutate data.
WITH declarations AS (
  SELECT o.issue_id, o.stage, o.outcome, o.blocked_on, o.task_id,
         t.issue_id AS task_issue_id, t.context->>'to_stage' AS task_stage,
         upper(m.captures[1]) AS declared_outcome, m.ordinality,
         i.number AS issue_number, i.status AS current_issue_status
    FROM issue_stage_outcome o
    JOIN issue i ON i.id = o.issue_id
    JOIN agent_task_queue t ON t.id = o.task_id
   CROSS JOIN LATERAL regexp_matches(
         COALESCE(t.result->>'output', ''),
         '(?im)^OUTCOME:[[:space:]]*(ADVANCED|NO_OP)[[:space:]]*$', 'g'
       ) WITH ORDINALITY AS m(captures, ordinality)
   WHERE i.workspace_id = :'workspace_id'::uuid
     AND o.blocked_on = 'human'
), candidates AS (
  SELECT DISTINCT ON (issue_id, stage) *
    FROM declarations
   ORDER BY issue_id, stage, ordinality DESC
)
SELECT (stage = task_stage) AS stage_matches_task,
       outcome AS stored_outcome, declared_outcome, current_issue_status,
       count(*) AS repair_candidates
  FROM candidates
 WHERE issue_id = task_issue_id
 GROUP BY stage_matches_task, stored_outcome, declared_outcome, current_issue_status
 ORDER BY stage_matches_task, stored_outcome, declared_outcome, current_issue_status;
