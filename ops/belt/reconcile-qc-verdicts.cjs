#!/usr/bin/env node
// Reconcile legacy verdicts before the qc_attempt binding trigger is enabled.
// It never guesses from branches or prose: only structured task fields can rebound.
const { Pool } = require('pg');
const { currentStrictPass } = require('./qc-strict-evidence.cjs');

function parseArgs(args) {
  if (args.length > 1 || (args[0] && !['--dry-run', '--apply'].includes(args[0]))) {
    throw new Error('usage: reconcile-qc-verdicts [--dry-run|--apply]');
  }
  return { mode: args[0] === '--apply' ? 'apply' : 'dry-run' };
}

const LEGACY_SQL = `SELECT v.id AS verdict_id, v.issue_id, v.checker_id, v.checker_name,
       v.verdict, v.work_product_md5, t.id AS task_id, t.result, a.name AS agent_name
  FROM qc_verdict v
  LEFT JOIN LATERAL (
    SELECT t.id, t.result, a.name FROM agent_task_queue t JOIN agent a ON a.id=t.agent_id
     WHERE t.issue_id=v.issue_id AND t.agent_id=v.checker_id AND t.status='completed'
       AND a.model='gpt-5.6-sol' AND a.thinking_level='low'
       AND t.result->>'work_product_md5'=v.work_product_md5
       AND t.result->>'bound_sha' ~* '^[0-9a-f]{40}$'
       AND lower(t.result->>'bound_sha')=lower(t.result->>'observed_sha')
     ORDER BY t.completed_at DESC, t.id DESC LIMIT 2
  ) t ON true
 WHERE v.verdict='PASS' ORDER BY v.created_at, v.id`;

async function reconcile(client, { mode }) {
  await client.query('BEGIN');
  try {
    const { rows } = await client.query(LEGACY_SQL);
    const receipts = [];
    for (const row of rows) {
      if (await currentStrictPass(client, row.issue_id)) continue;
      const exact = row.task_id && row.result?.bound_sha && row.result?.observed_sha;
      const receipt = { issue_id: row.issue_id, verdict_id: row.verdict_id,
        action: exact ? 'rebound' : 'quarantined', task_id: row.task_id || null };
      receipts.push(receipt);
      if (mode !== 'apply') continue;
      if (exact) {
        await client.query(`INSERT INTO qc_attempt
          (issue_id, checker_name, verdict, work_product_md5, bound_sha, observed_head,
           failure_class, qualifying, model, effort, idem_key, notes)
          VALUES ($1,$2,'PASS',$3,$4,$5,NULL,true,'gpt-5.6-sol','low',$6,$7)
          ON CONFLICT (idem_key) DO NOTHING`, [row.issue_id, row.agent_name || row.checker_name,
          row.work_product_md5, row.result.bound_sha, row.result.observed_sha,
          `reconcile-qc-verdict:${row.verdict_id}`, `relay_task_id=${row.task_id}`]);
      } else {
        await client.query(`UPDATE qc_verdict SET verdict='FAIL', notes=concat_ws(E'\\n', notes,
          'qc_attempt_binding_required: quarantined; fresh QC required') WHERE id=$1`, [row.verdict_id]);
        await client.query(`UPDATE issue SET metadata=COALESCE(metadata,'{}'::jsonb) ||
          jsonb_build_object('fresh_qc_required','qc_attempt_binding_required') WHERE id=$1`, [row.issue_id]);
      }
    }
    if (mode === 'dry-run') await client.query('ROLLBACK'); else await client.query('COMMIT');
    return { mode, receipts };
  } catch (error) { try { await client.query('ROLLBACK'); } catch (_) {} throw error; }
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL }); const client = await pool.connect();
  try { console.log(JSON.stringify(await reconcile(client, parseArgs(process.argv.slice(2))))); }
  finally { client.release(); await pool.end(); }
}
if (require.main === module) main().catch(error => { console.error(JSON.stringify({ error: error.message })); process.exitCode = 1; });
module.exports = { LEGACY_SQL, parseArgs, reconcile };
