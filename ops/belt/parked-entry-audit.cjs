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

// Parked rows are operational evidence, not an unbounded caller payload.
const PARKED_AUDIT_MAX_BYTES = 4096;

function parkedEntryAudit({ trigger, intendedStage = null, attempts = 0, taskCount = 0,
  terminalExit = null, callerAudit = null }) {
  const supplied = callerAudit && typeof callerAudit === 'object' && !Array.isArray(callerAudit)
    ? callerAudit : {};
  const audit = {
    ...supplied,
    trigger,
    intended_stage: intendedStage,
    attempts: Number(attempts) || 0,
    task_count: Number(taskCount) || 0
  };
  const merged = terminalExit ? { ...audit, terminal_exit: terminalExit } : audit;
  if (Buffer.byteLength(JSON.stringify(merged), 'utf8') > PARKED_AUDIT_MAX_BYTES) {
    throw new Error(`parked_audit exceeds ${PARKED_AUDIT_MAX_BYTES} bytes`);
  }
  return merged;
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
  PARKED_AUDIT_MAX_BYTES,
  parkedEntryAudit,
  recordParkedEntry
};
