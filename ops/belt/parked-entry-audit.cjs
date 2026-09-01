const PARKED_ENTRY_LOG_SQL = `INSERT INTO relay_run_log
  (issue_id, from_stage, to_stage, status, parked_audit)
 VALUES ($1, $2, 'Parked', 'completed', $3::jsonb)
 RETURNING id`;

const PARKED_FLOW_PER_HOUR_SQL = `SELECT date_trunc('hour', created_at) AS hour,
       count(*) FILTER (WHERE to_stage = 'Parked')::int AS entries_per_hour,
       count(*) FILTER (
         WHERE from_stage = 'Parked' AND to_stage <> 'Parked'
       )::int AS exits_per_hour
  FROM relay_run_log
 WHERE to_stage = 'Parked' OR from_stage = 'Parked'
 GROUP BY 1
 ORDER BY 1`;

function parkedEntryAudit({ trigger, intendedStage = null, attempts = 0, taskCount = 0 }) {
  return {
    trigger,
    intended_stage: intendedStage,
    attempts: Number(attempts) || 0,
    task_count: Number(taskCount) || 0
  };
}

async function recordParkedEntry(client, { issueId, fromStage, ...audit }) {
  const result = await client.query(PARKED_ENTRY_LOG_SQL, [
    issueId,
    fromStage,
    JSON.stringify(parkedEntryAudit(audit))
  ]);
  return result.rows[0]?.id || null;
}

module.exports = {
  PARKED_ENTRY_LOG_SQL,
  PARKED_FLOW_PER_HOUR_SQL,
  parkedEntryAudit,
  recordParkedEntry
};
