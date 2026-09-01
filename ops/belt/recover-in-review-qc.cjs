#!/usr/bin/env node
// Explicit repair for cancelled, unstarted wrong-owner QC successors.
const { selectStageOwner, replaceStageTask } = require('./multica-bridge.cjs');
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

function parseArgs(argv) {
  const out = { apply: false, issueIds: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--apply') out.apply = true;
    else if (argv[i] === '--issue') {
      const id = argv[++i];
      if (!UUID.test(String(id || ''))) throw new Error('--issue requires a UUID');
      out.issueIds.push(id.toLowerCase());
    } else throw new Error(`unknown option: ${argv[i]}`);
  }
  if (!out.apply || out.issueIds.length === 0) throw new Error('--apply and at least one --issue are required');
  return out;
}

async function recover(client, issueId) {
  const issue = await client.query(
    `SELECT i.id, i.workspace_id, i.priority FROM issue i
      WHERE i.id = $1::uuid AND i.status = 'In Review'
        AND NOT EXISTS (SELECT 1 FROM agent_task_queue live WHERE live.issue_id = i.id
          AND live.context->>'to_stage' = 'In Review'
          AND live.status IN ('queued','dispatched','running','waiting_local_directory','deferred'))
        AND EXISTS (SELECT 1 FROM agent_task_queue wrong WHERE wrong.issue_id = i.id
          AND wrong.context->>'from_stage' = 'Parked' AND wrong.context->>'to_stage' = 'In Review'
          AND wrong.status = 'failed' AND wrong.started_at IS NULL
          AND wrong.failure_reason = 'operator_orphan_repair'
          AND NOT EXISTS (SELECT 1 FROM task_usage u WHERE u.task_id = wrong.id))
      FOR UPDATE`, [issueId]);
  const row = issue.rows[0];
  if (!row) return null;
  const owner = await selectStageOwner(client, row.workspace_id, 'In Progress', 'In Review');
  if (!owner?.agent_id) throw new Error(`no QC owner for ${issueId}`);
  return replaceStageTask(client, { issueId: row.id, workspaceId: row.workspace_id,
    fromStage: 'Parked', toStage: 'In Review', agentId: owner.agent_id,
    runtimeId: owner.selected_runtime_id, priority: ({ urgent: 4, high: 3, medium: 2, low: 1 }[row.priority] || 0),
    context: JSON.stringify({ source: 'operator-qc-recovery', from_stage: 'Parked', to_stage: 'In Review' }),
    triggerSummary: 'Operator recovery: failed unstarted Parked -> In Review successor' });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    for (const issueId of options.issueIds) {
      const client = await pool.connect();
      try { await client.query('BEGIN'); const task = await recover(client, issueId); await client.query('COMMIT'); console.log(JSON.stringify({ issue_id: issueId, task_id: task?.taskId || null })); }
      catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
    }
  } finally { await pool.end(); }
}
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { parseArgs, recover };
