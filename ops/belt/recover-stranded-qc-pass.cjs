const { Pool } = require('pg');
const { currentStrictPass } = require('./qc-strict-evidence.cjs');
const { QC_LANE_EFFORT, qcLaneModelsSqlArray } = require('./qc-lane.cjs');

function parseArgs(args) {
  let mode = 'dry-run';
  for (const arg of args) {
    if (arg === '--apply') mode = 'apply';
    else if (arg === '--dry-run') mode = 'dry-run';
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (args.includes('--apply') && args.includes('--dry-run')) {
    throw new Error('--apply and --dry-run are mutually exclusive');
  }
  return { mode };
}

const CANDIDATE_SQL = `SELECT DISTINCT ON (i.id)
       rrl.id AS relay_log_id, i.id AS issue_id, i.number,
       verdict.work_product_md5
  FROM issue i
  JOIN relay_stage_config rsc
    ON rsc.workspace_id = i.workspace_id
   AND rsc.stage_name = i.status
  JOIN LATERAL (
    SELECT checker_id, verdict, work_product_md5
      FROM qc_verdict
     WHERE issue_id = i.id
     ORDER BY created_at DESC
     LIMIT 1
  ) verdict ON true
  JOIN relay_run_log rrl
    ON rrl.issue_id = i.id
   AND rrl.to_stage = 'In Review'
   AND rrl.status = 'completed'
 WHERE i.status = 'In Review'
   AND rsc.next_stage = 'CI/CD & Deploy'
   AND verdict.verdict = 'PASS'
   AND verdict.work_product_md5 ~* '^[0-9a-f]{32}$'
   AND EXISTS (
     SELECT 1 FROM qc_attempt qa
      JOIN agent_task_queue t ON t.issue_id=qa.issue_id
       AND t.id::text=substring(qa.notes FROM 'relay_task_id=([0-9a-f-]{36})') AND t.status='completed'
      JOIN agent a ON a.id=t.agent_id
     WHERE qa.issue_id=i.id AND qa.work_product_md5=verdict.work_product_md5
       AND qa.verdict='PASS' AND qa.qualifying=true AND qa.bound_sha ~* '^[0-9a-f]{40}$'
       AND lower(qa.bound_sha)=lower(qa.observed_head) AND t.agent_id=verdict.checker_id
       AND a.model = ANY($1::text[]) AND a.thinking_level = $2::text
   )
   AND NOT EXISTS (
     SELECT 1 FROM relay_run_log pending
      WHERE pending.issue_id = i.id AND pending.status = 'pending'
   )
   AND EXISTS (
     SELECT 1
       FROM agent_task_queue evidence_task
       JOIN agent evidence_agent
         ON evidence_agent.id = evidence_task.agent_id
        AND evidence_agent.workspace_id = i.workspace_id
      WHERE evidence_task.issue_id = i.id
        AND evidence_task.agent_id = verdict.checker_id
        AND evidence_task.status = 'completed'
        AND COALESCE(evidence_agent.model,
                     evidence_agent.runtime_config->>'model') = ANY($1::text[])
        AND COALESCE(evidence_agent.thinking_level,
                     evidence_agent.runtime_config->>'reasoning_effort') = $2::text
   )
 ORDER BY i.id, rrl.created_at DESC, rrl.id DESC`;

async function recover(client, { mode }) {
  await client.query('BEGIN');
  try {
    const candidates = await client.query(CANDIDATE_SQL, [qcLaneModelsSqlArray(), QC_LANE_EFFORT]);
    // Keep recovery on the same exact-one-attempt contract as deploy/Done.
    const strictCandidates = [];
    for (const candidate of candidates.rows) {
      if (await currentStrictPass(client, candidate.issue_id)) strictCandidates.push(candidate);
    }
    if (mode === 'dry-run') {
      await client.query('ROLLBACK');
      return { mode, candidates: strictCandidates, reopened: [] };
    }
    const reopened = [];
    for (const row of strictCandidates) {
      const result = await client.query(
        `UPDATE relay_run_log
            SET status = 'pending'
          WHERE id = $1 AND status = 'completed'
          RETURNING id AS relay_log_id, issue_id`, [row.relay_log_id]
      );
      reopened.push(...result.rows);
    }
    await client.query('COMMIT');
    return { mode, candidates: strictCandidates, reopened };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL,
    application_name: 'recover-stranded-qc-pass' });
  const client = await pool.connect();
  try {
    const result = await recover(client, options);
    console.log(JSON.stringify(result));
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(JSON.stringify({ error: err.message }));
    process.exitCode = 1;
  });
}

module.exports = { CANDIDATE_SQL, parseArgs, recover };
