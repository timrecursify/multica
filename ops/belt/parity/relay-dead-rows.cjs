'use strict';

const { QC_LANE_EFFORT, isQcLane, qcLaneModelsSqlArray } = require('../qc-lane.cjs');

function conversionEnabled(env = process.env) {
  return String(env.RELAY_QC_EVIDENCE_CONVERSION || 'on').toLowerCase() !== 'off';
}

function qcTaskEvidenceResult(task) {
  const output = task.result && typeof task.result === 'object' ? task.result.output : null;
  if (typeof output !== 'string') return { reason: 'missing-output' };
  // A marker may be plain, inline-code wrapped, or placed inside a Markdown
  // fence.  The line matcher intentionally counts all three forms so the
  // exactly-one-marker rule is retained across presentation styles.
  const matches = [...output.matchAll(/^(?:QC_EVIDENCE_JSON=([^\r\n]*)|`QC_EVIDENCE_JSON=([^\r\n]*)`)$/gm)];
  if (matches.length === 0) return { reason: 'missing-marker' };
  if (matches.length !== 1) return { reason: 'duplicate-marker' };
  try {
    const evidence = JSON.parse(matches[0][1] ?? matches[0][2]);
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence) ||
      !['PASS', 'FAIL'].includes(evidence.verdict) ||
      !/^[0-9a-f]{32}$/i.test(String(evidence.work_product_md5 || '')) ||
      !/^[0-9a-f]{40}$/i.test(String(evidence.bound_sha || '')) ||
      !/^[0-9a-f]{40}$/i.test(String(evidence.observed_sha || '')) ||
      String(evidence.bound_sha).toLowerCase() !== String(evidence.observed_sha).toLowerCase() ||
      !['none', 'implementation', 'evidence', 'tool', 'access'].includes(evidence.failure_class) ||
      typeof evidence.qualifying !== 'boolean' || !isQcLane(evidence.model, evidence.effort)) {
      return { reason: 'invalid-evidence' };
    }
    return { evidence };
  } catch { return { reason: 'invalid-json' }; }
}

function qcTaskEvidence(task) {
  return qcTaskEvidenceResult(task).evidence || null;
}

function noArtifactRescopeBatch(env = process.env) {
  const fallback = Number(env.RELAY_REQUEUE_BATCH || 8);
  const batch = Number(env.RELAY_NOARTIFACT_RESCOPE_BATCH || fallback);
  return Number.isInteger(batch) && batch > 0 ? batch : fallback;
}

async function convertCompletedQcEvidence(client, { postRelay, logger = console,
  logPrefix = '[relay-advance-daemon]', env = process.env } = {}) {
  if (!conversionEnabled(env)) return new Set();
  const candidates = await client.query(
    `SELECT t.id, t.issue_id, t.created_at, t.result, a.name AS agent_name, i.number,
            COALESCE(a.model, a.runtime_config->>'model') AS agent_model,
            COALESCE(a.thinking_level, a.runtime_config->>'reasoning_effort') AS agent_effort
       FROM agent_task_queue t
       JOIN issue i ON i.id = t.issue_id AND i.workspace_id = t.workspace_id
       JOIN agent a ON a.id = t.agent_id AND a.workspace_id = i.workspace_id
      WHERE t.status = 'completed' AND t.context->>'to_stage' = 'In Review'
        AND t.result->>'output' LIKE '%QC_EVIDENCE_JSON=%'
        AND COALESCE(a.model, a.runtime_config->>'model') = ANY($1::text[])
        AND COALESCE(a.thinking_level, a.runtime_config->>'reasoning_effort') = $2::text
        AND NOT EXISTS (
          SELECT 1 FROM qc_verdict verdict WHERE verdict.issue_id = t.issue_id
            AND verdict.created_at >= t.created_at)
      ORDER BY t.issue_id, t.completed_at DESC NULLS LAST, t.created_at DESC, t.id DESC
      LIMIT 100`, [qcLaneModelsSqlArray(), QC_LANE_EFFORT]
  );
  const converted = new Set();
  const seenIssues = new Set();
  for (const task of candidates.rows) {
    if (seenIssues.has(task.issue_id)) continue;
    const parsed = qcTaskEvidenceResult(task);
    if (!parsed.evidence) {
      logger.log(`${logPrefix} [qc-evidence-skipped] task=${task.id} reason=${parsed.reason}`);
      continue;
    }
    const { evidence } = parsed;
    seenIssues.add(task.issue_id);
    if (evidence.model !== task.agent_model || evidence.effort !== task.agent_effort) {
      logger.log(`${logPrefix} [qc-evidence-model-mismatch] task=${task.id} ` +
        `evidence=${evidence.model}/${evidence.effort} agent=${task.agent_model}/${task.agent_effort}`);
    }
    const payload = { issue_id: task.issue_id, checker: task.agent_name,
      verdict: evidence.verdict, work_product_md5: evidence.work_product_md5,
      bound_sha: evidence.bound_sha, observed_sha: evidence.observed_sha,
      failure_class: evidence.failure_class, qualifying: evidence.qualifying,
      model: task.agent_model, effort: task.agent_effort,
      // Key per QC task: a re-QC of the same sha by another checker is a new
      // verdict, not a replay. The old sha-only key returned 409
      // idempotency_conflict for every re-run and left 55 issues unverdicted.
      idem_key: `qc-${task.number}-${evidence.bound_sha}-${evidence.verdict}-${String(task.id).slice(0, 8)}`,
      qc_task_id: task.id };
    const result = await postRelay(payload);
    if (result && result.status >= 200 && result.status < 300) {
      converted.add(task.id);
      logger.log(`${logPrefix} [qc-evidence-converted] task=${task.id}`);
    } else {
      logger.log(`${logPrefix} [qc-evidence-rejected] task=${task.id} status=${result && result.status} error=${(result && (result.error || result.body)) || 'unknown'}`);
    }
  }
  return converted;
}

async function rescopeCompletedNoArtifactQc(client, { postRelay, logger = console,
  logPrefix = '[relay-advance-daemon]', env = process.env } = {}) {
  const { isNoArtifactQcBlock, taskResultText } = require('../multica-bridge.cjs');
  const candidates = await client.query(
    `SELECT t.id, t.issue_id, t.result
       FROM agent_task_queue t
       JOIN issue i ON i.id = t.issue_id AND i.workspace_id = t.workspace_id
       JOIN agent a ON a.id = t.agent_id AND a.workspace_id = i.workspace_id
      WHERE i.status = 'In Review'
        AND NOT (i.metadata ? 'no_artifact_rescope_consumed_at')
        AND t.status = 'completed'
        AND t.context->>'to_stage' = 'In Review'
        AND t.result->>'output' ~* '^\\s*QC[- ]BLOCKED'
        AND COALESCE(a.model, a.runtime_config->>'model') = ANY($1::text[])
        AND COALESCE(a.thinking_level, a.runtime_config->>'reasoning_effort') = $2::text
        AND NOT EXISTS (
          SELECT 1 FROM qc_verdict verdict WHERE verdict.issue_id = t.issue_id
            AND verdict.created_at >= t.created_at)
        AND NOT EXISTS (
          SELECT 1 FROM agent_task_queue live WHERE live.issue_id = t.issue_id
            AND live.status IN ('queued', 'running'))
      ORDER BY t.issue_id, t.completed_at DESC NULLS LAST, t.created_at DESC, t.id DESC
      LIMIT $3`, [qcLaneModelsSqlArray(), QC_LANE_EFFORT, noArtifactRescopeBatch(env)]
  );
  const converted = new Set();
  const seenIssues = new Set();
  for (const task of candidates.rows) {
    if (seenIssues.has(task.issue_id) || qcTaskEvidence(task) ||
      !isNoArtifactQcBlock(taskResultText(task.result))) continue;
    seenIssues.add(task.issue_id);
    const result = await postRelay({ issue_id: task.issue_id, to_stage: 'In Progress',
      reason: 'QC-BLOCKED NO-SHA relay return',
      evidence: { implementationFail: 'qc_blocked_no_artifact', retryRemaining: true } });
    if (result && result.status >= 200 && result.status < 300) {
      converted.add(task.id);
      logger.log(`${logPrefix} [qc-no-artifact-rescoped] task=${task.id}`);
    } else if (result && result.status === 409) {
      logger.log(`${logPrefix} [qc-no-artifact-skipped] task=${task.id} status=409`);
    }
  }
  return converted;
}

// Close ledger-only and permanently inadmissible relay rows before the normal
// advance window.  Claiming the QC row first makes retry escalation exactly-once
// even if two daemon processes overlap.
async function closeDeadRelayRows(client, { terminalStages, requestRetryEscalation,
  postRelay, postVerdict = postRelay, postNoArtifactRescope = postRelay, logger = console, logPrefix = '[relay-advance-daemon]', env = process.env }) {
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

  await convertCompletedQcEvidence(client, { postRelay: postVerdict, logger, logPrefix, env });
  await rescopeCompletedNoArtifactQc(client, { postRelay: postNoArtifactRescope, logger, logPrefix, env });

  const candidates = await client.query(
    `SELECT rrl.id AS log_id, atq.id AS task_id, atq.issue_id, rrl.to_stage
       FROM relay_run_log rrl
       INNER JOIN agent_task_queue atq ON atq.id = rrl.task_id
      WHERE rrl.status = 'pending'
        AND rrl.to_stage = 'In Review'
        AND atq.status = 'completed'
        AND NOT EXISTS (
          -- A verdict may be recorded before a redundant relay task is
          -- created.  Admit only the same formal evidence relationship used
          -- by the advance daemon; timestamps alone are not evidence.
          SELECT 1
            FROM qc_verdict verdict
            INNER JOIN qc_attempt attempt
                    ON attempt.issue_id = verdict.issue_id
                   AND attempt.verdict = 'PASS'
                   AND attempt.qualifying = true
                   AND attempt.work_product_md5 = verdict.work_product_md5
            INNER JOIN agent_task_queue evidence_task
                    ON evidence_task.issue_id = attempt.issue_id
                   AND evidence_task.id::text = substring(
                         attempt.notes FROM 'relay_task_id=([0-9a-f-]{36})')
                   AND evidence_task.status = 'completed'
            INNER JOIN agent evidence_agent
                    ON evidence_agent.id = evidence_task.agent_id
           WHERE verdict.issue_id = atq.issue_id
             AND verdict.verdict = 'PASS'
             AND verdict.checker_id = evidence_task.agent_id
             AND evidence_agent.workspace_id = evidence_task.workspace_id
             AND COALESCE(evidence_agent.model,
                          evidence_agent.runtime_config->>'model') = ANY($1::text[])
             AND COALESCE(evidence_agent.thinking_level,
                          evidence_agent.runtime_config->>'reasoning_effort') = $2::text
             AND lower(attempt.bound_sha) = lower(attempt.observed_head)
             AND attempt.bound_sha ~* '^[0-9a-f]{40}$'
             AND attempt.work_product_md5 ~* '^[0-9a-f]{32}$')`,
    [qcLaneModelsSqlArray(), QC_LANE_EFFORT]
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

module.exports = { closeDeadRelayRows, convertCompletedQcEvidence, conversionEnabled,
  noArtifactRescopeBatch, rescopeCompletedNoArtifactQc };
