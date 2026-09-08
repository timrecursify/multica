-- GSP-2595 reviewed data repair. DO NOT run from the belt daemon.
-- Production verification on 2026-09-08 found 82 current corrupt rows: the
-- reported 81 FAILED/human rows plus GSP-2331's ADVANCED/human row. The source
-- task must belong to the same issue and its last typed declaration must be a
-- successful ADVANCED or NO_OP. No issue status or agent_task_queue row changes.
--
-- Run the companion gsp-2595-repair-report.sql first and retain its output.
-- The seat should run this whole file in psql after reviewing the candidate and
-- eligibility result sets. Replace the final ROLLBACK with COMMIT only then.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TEMP TABLE gsp_2595_candidates ON COMMIT DROP AS
WITH declarations AS (
  SELECT o.issue_id, o.stage, o.outcome, o.blocked_on, o.task_id,
         o.input_hash, o.outcome_at, t.context->>'to_stage' AS task_stage,
         upper(m.captures[1]) AS declared_outcome, m.ordinality,
         i.number AS issue_number, i.status AS current_issue_status
    FROM issue_stage_outcome o
    JOIN issue i ON i.id = o.issue_id
    JOIN agent_task_queue t ON t.id = o.task_id AND t.issue_id = o.issue_id
   CROSS JOIN LATERAL regexp_matches(
         COALESCE(t.result->>'output', ''),
         '(?im)^OUTCOME:[[:space:]]*(ADVANCED|NO_OP)[[:space:]]*$', 'g'
       ) WITH ORDINALITY AS m(captures, ordinality)
   WHERE i.workspace_id = 'f47e92d1-8c9e-4f2a-9b3c-7e2a4d1b5c6f'::uuid
     AND o.blocked_on = 'human'
), latest AS (
  SELECT DISTINCT ON (issue_id, stage) *
    FROM declarations
   ORDER BY issue_id, stage, ordinality DESC
)
SELECT latest.*,
       EXISTS (SELECT 1 FROM issue_stage_outcome target
                WHERE target.issue_id = latest.issue_id
                  AND target.stage = latest.task_stage) AS target_existed
  FROM latest
 WHERE task_stage IN ('Queue', 'In Progress', 'In Review', 'Spec')
   AND declared_outcome IN ('ADVANCED', 'NO_OP');

-- Review gate: expected from the cited incident is 82 = 81 FAILED/human plus
-- the separate ADVANCED/human GSP-2331 row. Stop if production has drifted.
DO $verify$
DECLARE candidate_count integer;
BEGIN
  SELECT count(*) INTO candidate_count FROM gsp_2595_candidates;
  IF candidate_count <> 82 THEN
    RAISE EXCEPTION 'GSP-2595 candidate drift: expected 82, found %', candidate_count;
  END IF;
END
$verify$;

TABLE gsp_2595_candidates;

-- Durable rollback capture. It intentionally has no index; repository policy
-- requires concurrent indexes in separate migrations, and this small audit
-- table does not need one.
CREATE TABLE IF NOT EXISTS gsp_2595_outcome_repair_backup_20260908 (
  issue_id uuid NOT NULL, stage text NOT NULL, outcome text NOT NULL,
  blocked_on text, task_id uuid, input_hash text, outcome_at timestamptz,
  task_stage text NOT NULL, declared_outcome text NOT NULL,
  target_existed boolean NOT NULL, captured_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO gsp_2595_outcome_repair_backup_20260908
  (issue_id, stage, outcome, blocked_on, task_id, input_hash, outcome_at,
   task_stage, declared_outcome, target_existed)
SELECT issue_id, stage, outcome, blocked_on, task_id, input_hash, outcome_at,
       task_stage, declared_outcome, target_existed
  FROM gsp_2595_candidates c
 WHERE NOT EXISTS (
   SELECT 1 FROM gsp_2595_outcome_repair_backup_20260908 b
    WHERE b.issue_id = c.issue_id AND b.stage = c.stage);

-- Same-stage rows retain their proven task association and recover the task's
-- final typed declaration.
UPDATE issue_stage_outcome o
   SET outcome = c.declared_outcome, blocked_on = NULL, outcome_at = now()
  FROM gsp_2595_candidates c
 WHERE o.issue_id = c.issue_id AND o.stage = c.stage
   AND c.stage = c.task_stage AND o.task_id = c.task_id;

-- A mismatched row cannot retain its task_id. When the task's real stage has no
-- row, move the row to that stage; otherwise preserve the independently newer
-- target-stage row and remove only the corrupt cross-stage alias.
DELETE FROM issue_stage_outcome o
 USING gsp_2595_candidates c
 WHERE o.issue_id = c.issue_id AND o.stage = c.stage
   AND c.stage <> c.task_stage;

INSERT INTO issue_stage_outcome
  (issue_id, stage, outcome, blocked_on, task_id, input_hash, outcome_at)
SELECT issue_id, task_stage, declared_outcome, NULL, task_id, input_hash, now()
  FROM gsp_2595_candidates
 WHERE stage <> task_stage AND target_existed IS FALSE
ON CONFLICT (issue_id, stage) DO NOTHING;

-- Exact tickets restored to an authoritative successful task outcome. Tickets
-- still in Human Review are not moved by this repair; the seat decides release.
SELECT DISTINCT i.number, i.status, o.stage AS eligible_stage, o.outcome, o.task_id
  FROM gsp_2595_candidates c
  JOIN issue i ON i.id = c.issue_id
  JOIN issue_stage_outcome o ON o.issue_id = c.issue_id
       AND o.stage = c.task_stage AND o.task_id = c.task_id
       AND o.outcome IN ('ADVANCED', 'NO_OP') AND o.blocked_on IS NULL
 ORDER BY i.number;

SELECT count(*) AS remaining_task_stage_mismatches
  FROM issue_stage_outcome o
  JOIN agent_task_queue t ON t.id = o.task_id
  JOIN issue i ON i.id = o.issue_id
 WHERE i.workspace_id = 'f47e92d1-8c9e-4f2a-9b3c-7e2a4d1b5c6f'::uuid
   AND (t.issue_id <> o.issue_id OR t.context->>'to_stage' <> o.stage);

ROLLBACK;

-- Reviewed rollback after a committed repair:
-- 1. BEGIN and lock the affected issue_stage_outcome rows.
-- 2. Delete rows at task_stage only where target_existed=false and task_id is
--    the captured task_id.
-- 3. Upsert every captured (issue_id, stage) row with its original values.
-- 4. Compare against gsp_2595-repair-report.sql, then COMMIT.
