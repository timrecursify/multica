#!/usr/bin/env node
const http = require('node:http');
const { diagnosisEvidence, verifyRuntimeEvidence } = require('./parked-diagnosis.cjs');
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const RECOVERY_MARKER = 'parked_qc_recovery';

function diagnosisText(result) {
  if (typeof result === 'string') return result;
  if (!result || typeof result !== 'object') return '';
  return [result.comment, result.output, result.text, result.error].filter(Boolean).join('\n');
}

function parseArgs(argv) {
  const out = { apply: false, issueId: null, failedTaskId: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--apply') out.apply = true;
    else if (argv[i] === '--issue') out.issueId = String(argv[++i] || '').toLowerCase();
    else if (argv[i] === '--failed-task') out.failedTaskId = String(argv[++i] || '').toLowerCase();
    else throw new Error(`unknown option: ${argv[i]}`);
  }
  if (!out.apply || !UUID.test(out.issueId || '') || !UUID.test(out.failedTaskId || '')) throw new Error('--apply, --issue UUID, and --failed-task UUID are required');
  return out;
}

function relayAdvance(payload, request = http.request) {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: 5005, path: '/relay/advance', method: 'POST', timeout: 5000, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      res.resume(); res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode }));
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('relay timeout')); }); req.end(body);
  });
}

async function reserveRecovery(client, issueId, failedTaskId, verify = verifyRuntimeEvidence) {
  const candidate = await client.query(
    `SELECT i.id, d.id AS diagnosis_id, d.result AS diagnosis_result
       FROM issue i JOIN agent_task_queue failed ON failed.id = $2::uuid AND failed.issue_id = i.id
       JOIN agent_task_queue original ON original.id = (failed.context->>'requeue_of_task')::uuid AND original.issue_id = i.id
       JOIN agent a ON a.id = failed.agent_id AND a.workspace_id = i.workspace_id
       JOIN relay_stage_config cfg ON cfg.workspace_id = i.workspace_id AND cfg.stage_name = 'In Progress' AND cfg.next_stage = 'In Review' AND cfg.agent_id = failed.agent_id
       JOIN LATERAL (SELECT id, result FROM agent_task_queue d WHERE d.issue_id = i.id AND d.status = 'completed' AND d.context->>'kind' = 'parked_diagnosis' AND d.context->>'evidence_correction_retry' = 'true' ORDER BY d.completed_at DESC NULLS LAST, d.created_at DESC, d.id DESC LIMIT 1) d ON true
      WHERE i.id = $1::uuid AND i.status = 'Parked'
        AND failed.context->>'source' = 'relay-requeue' AND failed.context->>'from_stage' = 'In Progress' AND failed.context->>'to_stage' = 'In Review' AND failed.context->>'dead_task_reason' = 'operator_orphan_repair'
        AND failed.status = 'failed' AND failed.failure_reason = 'cancelled' AND failed.started_at IS NOT NULL AND failed.completed_at IS NOT NULL
        AND original.context->>'from_stage' = 'Parked' AND original.context->>'to_stage' = 'In Review'
        AND original.status = 'failed' AND original.started_at IS NULL AND original.failure_reason = 'operator_orphan_repair'
        AND COALESCE(a.model, a.runtime_config->>'model') = 'gpt-5.6-sol' AND COALESCE(a.thinking_level, a.runtime_config->>'reasoning_effort') = 'low'
        AND NOT EXISTS (SELECT 1 FROM task_usage u WHERE u.task_id = failed.id)
        AND NOT EXISTS (SELECT 1 FROM task_usage original_usage WHERE original_usage.task_id = original.id)
        AND NOT EXISTS (SELECT 1 FROM agent_task_queue live WHERE live.issue_id = i.id AND live.context->>'to_stage' = 'In Review' AND live.status IN ('queued','dispatched','running','waiting_local_directory','deferred'))
      FOR UPDATE OF i, failed, d`, [issueId, failedTaskId]);
  const row = candidate.rows[0]; if (!row) return null;
  const evidence = diagnosisEvidence(diagnosisText(row.diagnosis_result));
  if (!evidence || !await verify(client, row.id, evidence, row.diagnosis_id)) return null;
  const marker = JSON.stringify({ failed_task_id: failedTaskId, canonical_evidence: evidence });
  const reserved = await client.query(
    `UPDATE issue SET metadata = jsonb_set(jsonb_set(COALESCE(metadata, '{}'::jsonb), '{parked_release_once}', 'true'::jsonb, true), $3::text[], $4::jsonb, true), updated_at = NOW()
      WHERE id = $1::uuid AND status = 'Parked' AND (NOT (COALESCE(metadata, '{}'::jsonb) ? $2::text) OR (metadata->$2->>'failed_task_id' = $5::text AND metadata->$2->>'canonical_evidence' = $6::text)) RETURNING id`,
    [issueId, RECOVERY_MARKER, [RECOVERY_MARKER], marker, failedTaskId, evidence]);
  return reserved.rowCount ? { issueId: row.id, evidence } : null;
}

async function recover(client, issueId, failedTaskId, deps = {}) {
  const reservation = await reserveRecovery(client, issueId, failedTaskId, deps.verifyRuntimeEvidence || verifyRuntimeEvidence);
  if (!reservation) return null;
  try {
    const response = await (deps.relayAdvance || relayAdvance)({ issue_id: reservation.issueId, to_stage: 'In Review', reason: `runtime_evidence_verified:${reservation.evidence}`, agent_token: deps.relayToken || process.env.RELAY_AGENT_SECRET });
    if (response.ok) return response;
    throw new Error(`relay rejected recovery: ${response.status}`);
  } catch (error) {
    await client.query(`UPDATE issue SET metadata = COALESCE(metadata, '{}'::jsonb) - 'parked_release_once', updated_at = NOW() WHERE id = $1::uuid AND status = 'Parked'`, [issueId]);
    throw error;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!process.env.DATABASE_URL || !process.env.RELAY_AGENT_SECRET) throw new Error('DATABASE_URL and RELAY_AGENT_SECRET are required');
  const { Pool } = require('pg'); const pool = new Pool({ connectionString: process.env.DATABASE_URL }); const client = await pool.connect();
  let reservation;
  try { await client.query('BEGIN'); reservation = await reserveRecovery(client, options.issueId, options.failedTaskId); await client.query('COMMIT'); }
  catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
  if (!reservation) { await pool.end(); throw new Error('recovery preconditions refused'); }
  try {
    const result = await relayAdvance({ issue_id: reservation.issueId, to_stage: 'In Review', reason: `runtime_evidence_verified:${reservation.evidence}`, agent_token: process.env.RELAY_AGENT_SECRET });
    if (!result.ok) throw new Error(`relay rejected recovery: ${result.status}`);
    console.log(JSON.stringify(result));
  } catch (error) {
    await pool.query(`UPDATE issue SET metadata = COALESCE(metadata, '{}'::jsonb) - 'parked_release_once', updated_at = NOW() WHERE id = $1::uuid AND status = 'Parked'`, [options.issueId]);
    throw error;
  } finally { await pool.end(); }
}
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { parseArgs, diagnosisText, relayAdvance, reserveRecovery, recover, RECOVERY_MARKER };
