'use strict';

// Close ledger-only and permanently inadmissible relay rows before the normal
// advance window.  Claiming the QC row first makes retry escalation exactly-once
// even if two daemon processes overlap.
async function closeDeadRelayRows(client, { terminalStages, requestRetryEscalation,
  postRelay, logger = console, logPrefix = '[relay-advance-daemon]' }) {
  const terminal = await client.query(
    `UPDATE relay_run_log
        SET status = 'completed'
      WHERE status = 'pending'
        AND to_stage = ANY($1)`,
    [terminalStages]
  );
  if (terminal.rowCount > 0) {
    logger.log(`${logPrefix} Closed ${terminal.rowCount} terminal relay log(s)`);
  }

  const candidates = await client.query(
    `SELECT rrl.id AS log_id, atq.id AS task_id, atq.issue_id, rrl.to_stage
       FROM relay_run_log rrl
       INNER JOIN agent_task_queue atq ON atq.id = rrl.task_id
      WHERE rrl.status = 'pending'
        AND rrl.to_stage = 'In Review'
        AND atq.status = 'completed'
        AND NOT EXISTS (
          SELECT 1 FROM qc_verdict verdict
           WHERE verdict.issue_id = atq.issue_id
             AND verdict.created_at >= atq.created_at)`
  );
  for (const row of candidates.rows) {
    const claimed = await client.query(
      `UPDATE relay_run_log
          SET status = 'failed',
              parked_audit = jsonb_set(
                COALESCE(parked_audit, '{}'::jsonb),
                '{reason}', to_jsonb('qc_verdict_missing_after_task_created'::text))
        WHERE id = $1 AND status = 'pending'
        RETURNING id`,
      [row.log_id]
    );
    if (claimed.rowCount === 0) continue;
    const escalation = await requestRetryEscalation(row,
      'qc_verdict_missing_after_task_created', postRelay);
    logger.log(`${logPrefix} [qc-verdict-missing] RESPEC: issue=${row.issue_id}, ` +
      `relay=${row.log_id}, status=${escalation.status}`);
  }
}

module.exports = { closeDeadRelayRows };
