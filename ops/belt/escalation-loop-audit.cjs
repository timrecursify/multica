#!/usr/bin/env node
// Read-only, repeatable-read report for the escalation-loop parking audit.
const GSP = 'f47e92d1-8c9e-4f2a-9b3c-7e2a4d1b5c6f';
const PPP = 'da3c5c5c-a123-4567-b999-c3ed1820da00';

// Keep this text aligned with guardrails.budgetCountPredicate().  The historical
// qc_attempt join is deliberately separate: qc_verdict is current-state only.
const AUDIT_SQL = `
WITH parked AS (
  SELECT i.id, i.workspace_id, i.number
    FROM issue i
   WHERE i.workspace_id = ANY($1::uuid[]) AND i.status = 'Parked'
     AND EXISTS (SELECT 1 FROM relay_run_log l
                  WHERE l.issue_id = i.id AND l.to_stage = 'Parked'
                    AND l.status = 'completed'
                    AND l.parked_audit->>'reason' = 'escalation_loop')
), countable AS (
  SELECT p.workspace_id, p.number, t.id AS task_id, t.status AS task_status,
         t.result->>'output' AS output,
         EXISTS (SELECT 1 FROM qc_verdict verdict
                  WHERE verdict.issue_id = t.issue_id
                    AND verdict.checker_id = t.agent_id
                    AND verdict.created_at >= t.started_at) AS budget_has_verdict,
         a.verdict AS attempt_verdict, a.failure_class AS attempt_failure_class
    FROM parked p JOIN agent_task_queue t ON t.issue_id = p.id
    LEFT JOIN LATERAL (
      SELECT verdict, failure_class FROM qc_attempt
       WHERE issue_id = p.id
         AND notes ~ ('(^|\\n)relay_task_id=' || t.id::text || '(\\n|$)')
       ORDER BY created_at DESC, id DESC LIMIT 1
    ) a ON true
   WHERE (t.context->>'to_stage' IS DISTINCT FROM 'In Review'
          OR t.status IS DISTINCT FROM 'completed'
          OR EXISTS (SELECT 1 FROM qc_verdict verdict
                       WHERE verdict.issue_id = t.issue_id
                         AND verdict.checker_id = t.agent_id
                         AND verdict.created_at >= t.started_at))
)
SELECT workspace_id, number, task_id, task_status, output, budget_has_verdict,
       attempt_verdict, attempt_failure_class
  FROM countable ORDER BY workspace_id, number, task_id`;

function marker(output) {
  const matches = [...String(output || '').matchAll(/^QC_EVIDENCE_JSON=(\{[^\r\n]*\})$/gm)];
  if (matches.length !== 1) return null;
  try {
    const parsed = JSON.parse(matches[0][1]);
    return parsed && (parsed.verdict === 'PASS' || parsed.verdict === 'FAIL') ? parsed : null;
  } catch { return null; }
}

function classify(row) {
  const evidence = marker(row.output);
  // A failed relay or no historical judgement is a burned attempt regardless
  // of any marker left in output; this is the required defect precedence.
  if (row.task_status === 'failed' || !row.attempt_verdict) return 'defect';
  if (row.attempt_verdict === 'FAIL' || evidence?.failure_class === 'implementation') return 'genuine';
  return 'exception';
}

function summarise(rows) {
  const tickets = new Map();
  for (const row of rows) {
    const key = `${row.workspace_id}:${row.number}`;
    const item = tickets.get(key) || { workspace: row.workspace_id === GSP ? 'GSP' : 'PPP', issue: row.number,
      countable: 0, defect: 0, genuine: 0, exceptions: [] };
    item.countable += 1;
    const kind = classify(row);
    if (kind === 'defect') item.defect += 1;
    else if (kind === 'genuine') item.genuine += 1;
    else item.exceptions.push(row.task_id);
    tickets.set(key, item);
  }
  return [...tickets.values()].sort((a, b) => (b.defect / b.countable) - (a.defect / a.countable) ||
    a.workspace.localeCompare(b.workspace) || a.issue - b.issue);
}

function markdown(snapshot, tickets) {
  const gsp = tickets.filter((x) => x.workspace === 'GSP').length;
  const ppp = tickets.filter((x) => x.workspace === 'PPP').length;
  if (tickets.length !== 94 || gsp !== 65 || ppp !== 29) {
    throw new Error(`population discrepancy: total=${tickets.length}, GSP=${gsp}, PPP=${ppp}; expected 94/65/29`);
  }
  const exceptions = tickets.flatMap((x) => x.exceptions.map((task) => `${x.workspace}-${x.issue} task ${task}`));
  const invalid = tickets.filter((x) => x.defect + x.genuine !== x.countable);
  const total = tickets.reduce((sum, x) => sum + x.countable, 0);
  const lines = [`Snapshot: ${snapshot}`, '', '| workspace | issue | countable attempts | defect-shaped | genuine | defect-shaped ratio |',
    '|---|---:|---:|---:|---:|---:|'];
  for (const x of tickets) lines.push(`| ${x.workspace} | ${x.issue} | ${x.countable} | ${x.defect} | ${x.genuine} | ${(x.defect / x.countable).toFixed(3)} |`);
  lines.push('', `Aggregate countable attempts: ${total}.`, '', `Exceptions: ${exceptions.length ? exceptions.join('; ') : 'none'}.`);
  if (invalid.length) lines.push('Report incomplete: classification invariant failed; no cap recommendation.');
  else lines.push('Invariant: defect-shaped + genuine = countable for every ticket. Cap remains 2/6 pending human ruling.');
  return lines.join('\n');
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, application_name: 'escalation-loop-audit' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snapshot = (await client.query('SELECT now() AS snapshot')).rows[0].snapshot;
    const rows = (await client.query(AUDIT_SQL, [[GSP, PPP]])).rows;
    console.log(markdown(snapshot, summarise(rows)));
    await client.query('ROLLBACK');
  } finally { client.release(); await pool.end(); }
}
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { AUDIT_SQL, GSP, PPP, marker, classify, summarise, markdown };
