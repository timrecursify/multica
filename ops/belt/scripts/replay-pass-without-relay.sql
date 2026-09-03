-- Read-only operator query for PASS verdicts that need a relay row recreated.
SELECT i.number,
       i.id AS issue_id,
       verdict.created_at AS verdict_created_at,
       last_relay.created_at AS last_relay_created_at,
       last_relay.id AS last_relay_id
  FROM issue i
  JOIN relay_stage_config rsc
    ON rsc.workspace_id = i.workspace_id
   AND rsc.stage_name = i.status
  JOIN LATERAL (
    SELECT checker_id, verdict, created_at
      FROM qc_verdict
     WHERE issue_id = i.id
     ORDER BY created_at DESC, id DESC
     LIMIT 1
  ) verdict ON true
  JOIN LATERAL (
    SELECT id
      FROM agent_task_queue
     WHERE issue_id = i.id
       AND agent_id = verdict.checker_id
       AND status = 'completed'
     ORDER BY completed_at DESC, id DESC
     LIMIT 1
  ) evidence_task ON true
  LEFT JOIN LATERAL (
    SELECT id, created_at
      FROM relay_run_log
     WHERE issue_id = i.id
     ORDER BY created_at DESC, id DESC
     LIMIT 1
  ) last_relay ON true
 WHERE i.status = 'In Review'
   AND rsc.next_stage = 'CI/CD & Deploy'
   AND verdict.verdict = 'PASS'
   AND verdict.created_at > COALESCE(last_relay.created_at, '-infinity'::timestamptz)
   AND NOT EXISTS (
     SELECT 1 FROM relay_run_log pending
      WHERE pending.issue_id = i.id AND pending.status = 'pending'
   )
 ORDER BY verdict.created_at ASC
 LIMIT 100;
