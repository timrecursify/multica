'use strict';

function evidenceFromTask(task) {
  const output = task?.result?.output || '';
  const match = String(output).match(/^QC_EVIDENCE_JSON=(\{[^\r\n]*\})$/m);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

async function pickEscalationAgent(client, workspaceId) {
  const result = await client.query(`SELECT a.id, a.name,
      COALESCE((SELECT ar.id FROM agent_runtime ar WHERE ar.id = a.runtime_id
        AND ar.workspace_id = a.workspace_id AND ar.status = 'online'),
        (SELECT ar.id FROM agent_runtime ar WHERE ar.workspace_id = a.workspace_id
          AND ar.status = 'online' AND ar.provider = CASE WHEN a.model LIKE 'claude%' THEN 'claude' ELSE 'codex' END
          ORDER BY ar.updated_at DESC LIMIT 1)) AS runtime_id
    FROM agent a
    WHERE a.workspace_id = $1::uuid AND a.name LIKE '%-qc-esc-%' AND a.archived_at IS NULL
    ORDER BY (SELECT max(t.created_at) FROM agent_task_queue t
      WHERE t.agent_id = a.id AND t.context->>'source' = 'qc-escalate') NULLS FIRST, a.id
    LIMIT 1`, [workspaceId]);
  return result.rows[0]?.runtime_id ? result.rows[0] : null;
}

async function enqueueQcEscalation(client, { issueId, workspaceId, fromTaskId, reason, boundSha }) {
  const existing = await client.query(`SELECT 1 FROM agent_task_queue
    WHERE issue_id=$1::uuid AND context->>'source'='qc-escalate' AND status IN ('queued','running')
    UNION ALL SELECT 1 FROM agent_task_queue
    WHERE issue_id=$1::uuid AND context->>'source'='qc-escalate' AND status='completed'
      AND context->>'bound_sha'=$2 LIMIT 1`, [issueId, boundSha || '']);
  if (existing.rows[0]) return { status: 'duplicate' };
  const agent = await pickEscalationAgent(client, workspaceId);
  if (!agent) return { status: 'held' };
  const context = { source: 'qc-escalate', from_stage: 'In Review', to_stage: 'In Review',
    escalated_from_task: fromTaskId, reason: String(reason || '').slice(0, 500), bound_sha: boundSha || '' };
  const result = await client.query(`INSERT INTO agent_task_queue
    (agent_id, issue_id, workspace_id, status, runtime_id, context, trigger_summary, force_fresh_session,
     originator_source, trigger_evidence_kind)
    VALUES ($1,$2,$3::uuid,'queued',$4,$5::jsonb,$6,TRUE,'unattributed','relay_stage_transition') RETURNING id`,
    [agent.id, issueId, workspaceId, agent.runtime_id, JSON.stringify(context), `QC-ESCALATE: ${String(reason || '').slice(0, 450)}`]);
  return { status: 'queued', taskId: result.rows[0]?.id, agent };
}

module.exports = { evidenceFromTask, pickEscalationAgent, enqueueQcEscalation };
