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
        AND NOT EXISTS (SELECT 1 FROM task_usage u WHERE u.issue_id = i.id)
        AND NOT EXISTS (SELECT 1 FROM agent_task_queue live WHERE live.issue_id = i.id
          AND live.context->>'to_stage' = 'In Review'
          AND live.status IN ('queued','dispatched','running','waiting_local_directory','deferred'))
        AND EXISTS (SELECT 1 FROM agent_task_queue wrong WHERE wrong.issue_id = i.id
          AND wrong.context->>'from_stage' = 'Parked' AND wrong.context->>'to_stage' = 'In Review'
          AND wrong.status = 'cancelled' AND wrong.started_at IS NULL)
      FOR UPDATE`, [issueId]);
  const row = issue.rows[0];
  if (!row) return null;
  const owner = await selectStageOwner(client, row.workspace_id, 'In Progress', 'In Review');
  if (!owner?.agent_id) throw new Error(`no QC owner for ${issueId}`);
  return replaceStageTask(client, { issueId: row.id, workspaceId: row.workspace_id,
    fromStage: 'Parked', toStage: 'In Review', agentId: owner.agent_id,
    runtimeId: owner.selected_runtime_id, priority: ({ urgent: 4, high: 3, medium: 2, low: 1 }[row.priority] || 0),
    context: JSON.stringify({ source: 'operator-qc-recovery', from_stage: 'Parked', to_stage: 'In Review' }),
    triggerSummary: 'Operator recovery: cancelled unstarted Parked -> In Review successor' });
}

module.exports = { parseArgs, recover };
