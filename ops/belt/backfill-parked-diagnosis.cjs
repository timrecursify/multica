#!/usr/bin/env node

// One-shot operator backfill. It is intentionally separate from the live
// bridge: dry-run is read-only, apply is explicit, and each ticket is locked
// before the shared parking contract is called.
const { recordParkAndQueueDiagnosis, PARK_DIAGNOSIS_KIND } = require('./parked-diagnosis.cjs');

const DEFAULT_BATCH = 25;
const MAX_BATCH = 25;
// Candidate eligibility is applied in SQL. A ticket that has already received
// a diagnosis task (or a named blocker) is not a candidate, so successive
// invocations advance through the backlog instead of re-scanning its first
// blocked rows.
const MAX_SCAN_WINDOW = MAX_BATCH;
const NONTERMINAL = ['queued', 'dispatched', 'running', 'waiting_local_directory', 'deferred'];

function parseArgs(argv) {
  const out = { batch: DEFAULT_BATCH, workspace: null, mode: null, retryRuntimeEvidence: false,
    recoverRuntimeEvidenceIssues: [] };
  let modeCount = 0;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run' || arg === '--apply') {
      out.mode = arg.slice(2);
      modeCount += 1;
    }
    else if (arg === '--batch-size') out.batch = Number(argv[++i]);
    else if (arg === '--workspace') out.workspace = argv[++i];
    else if (arg === '--retry-runtime-evidence') out.retryRuntimeEvidence = true;
    else if (arg === '--recover-runtime-evidence-issue') {
      const issueId = argv[++i];
      if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(String(issueId || ''))) {
        throw new Error('--recover-runtime-evidence-issue requires a UUID');
      }
      out.recoverRuntimeEvidenceIssues.push(issueId.toLowerCase());
    }
    else if (arg === '--help') return { help: true };
    else throw new Error(`unknown option: ${arg}`);
  }
  if (modeCount !== 1) throw new Error('exactly one of --dry-run or --apply is required');
  if (!Number.isInteger(out.batch) || out.batch < 1 || out.batch > MAX_BATCH) {
    throw new Error(`--batch-size must be an integer from 1 to ${MAX_BATCH}`);
  }
  if (out.retryRuntimeEvidence && out.mode !== 'apply') {
    throw new Error('--retry-runtime-evidence requires --apply');
  }
  if (out.recoverRuntimeEvidenceIssues.length && out.mode !== 'apply') {
    throw new Error('--recover-runtime-evidence-issue requires --apply');
  }
  return out;
}

function usage() {
  return 'Usage: backfill-parked-diagnosis.cjs (--dry-run|--apply) [--batch-size N] [--workspace UUID] [--retry-runtime-evidence] [--recover-runtime-evidence-issue UUID]';
}

function failureReason(error) {
  const value = error && (error.code || error.message);
  const normalized = String(value || 'unknown_apply_rejection')
    .trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return normalized || 'unknown_apply_rejection';
}

function interleaveByWorkspace(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = String(row.workspace_id);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const ordered = [];
  const keys = [...groups.keys()].sort();
  for (let offset = 0; ; offset += 1) {
    let added = false;
    for (const key of keys) {
      const row = groups.get(key)[offset];
      if (row) { ordered.push(row); added = true; }
    }
    if (!added) return ordered;
  }
}

async function inspect(client, issue, options = {}) {
  const blocker = issue.metadata && typeof issue.metadata === 'object'
    ? issue.metadata.parked_blocker : null;
  const task = await client.query(
    `SELECT id, status, context FROM agent_task_queue
      WHERE issue_id = $1 AND context->>'kind' = $2
      ORDER BY created_at DESC, id DESC`, [issue.id, PARK_DIAGNOSIS_KIND]);
  if (task.rowCount) {
    // Any historical diagnosis is a lifetime guard. The newest status is
    // reported truthfully, including terminal failures/cancellations.
    const status = task.rows[0].status == null
      ? null : String(task.rows[0].status).toLowerCase();
    const reason = status === 'completed' ? 'completed_parked_diagnosis'
      : status === 'failed' ? 'failed_parked_diagnosis'
        : status === 'cancelled' ? 'cancelled_parked_diagnosis'
          : (status == null || NONTERMINAL.includes(status)) ? 'nonterminal_parked_diagnosis'
            : 'existing_parked_diagnosis';
    // Failed/cancelled diagnosis attempts are explicitly retryable. Completed
    // and nonterminal attempts stay protected from duplicate dispatch.
    const evidenceRetry = options.retryRuntimeEvidence === true &&
      blocker === 'runtime_evidence_unverified' && status === 'completed';
    const recoveryV2 = options.recoverRuntimeEvidenceIssues?.includes(issue.id) &&
      blocker === 'runtime_evidence_unverified' && status === 'completed' &&
      task.rows[0].context?.evidence_correction_retry === true &&
      task.rows[0].context?.runtime_evidence_recovery_consumed === true &&
      task.rows[0].context?.runtime_evidence_recovery_v2_requested !== true;
    if (recoveryV2) {
      return { kind: 'eligible', has_reason_comment: true,
        retrying: 'runtime_evidence_recovery_v2', status, prior_task_id: task.rows[0].id,
        previous_blocker: blocker };
    }
    if (evidenceRetry) {
      const priorRetry = await client.query(
        `SELECT 1 FROM agent_task_queue
          WHERE issue_id = $1 AND context->>'kind' = $2
            AND context->>'evidence_correction_retry' = 'true' LIMIT 1`,
        [issue.id, PARK_DIAGNOSIS_KIND]);
      if (!priorRetry.rowCount) {
        return { kind: 'eligible', has_reason_comment: true,
          retrying: 'runtime_evidence_correction', status, prior_task_id: task.rows[0].id,
          previous_blocker: blocker };
      }
      return { kind: 'skip', reason: 'completed_runtime_evidence_correction_retry', status,
        task_id: task.rows[0].id };
    }
    if (status === 'failed' || status === 'cancelled') {
      return { kind: 'eligible', has_reason_comment: true, retrying: reason, status,
        prior_task_id: task.rows[0].id, previous_blocker: blocker };
    }
    return { kind: 'skip', reason, status, task_id: task.rows[0].id };
  }
  const comment = await client.query(
    `SELECT 1 FROM comment WHERE issue_id = $1
      AND content LIKE '<!-- multica-park-reason -->%' LIMIT 1`, [issue.id]);
  return { kind: 'eligible', has_reason_comment: comment.rowCount > 0,
    previous_blocker: blocker };
}

async function run(pool, options) {
  const recoveryV2 = options.recoverRuntimeEvidenceIssues.length > 0;
  if (recoveryV2 && options.retryRuntimeEvidence) {
    throw new Error('runtime-evidence recovery modes are mutually exclusive');
  }
  const where = options.workspace ? 'AND i.workspace_id = $1' : '';
  const kindParam = options.workspace ? '$2' : '$1';
  const recoveryIdsParam = options.workspace ? '$3' : '$2';
  const limitParam = recoveryV2
    ? (options.workspace ? '$4' : '$3') : (options.workspace ? '$3' : '$2');
  const values = recoveryV2
    ? (options.workspace
      ? [options.workspace, PARK_DIAGNOSIS_KIND, options.recoverRuntimeEvidenceIssues, options.batch]
      : [PARK_DIAGNOSIS_KIND, options.recoverRuntimeEvidenceIssues, options.batch])
    : (options.workspace
      ? [options.workspace, PARK_DIAGNOSIS_KIND, options.batch]
      : [PARK_DIAGNOSIS_KIND, options.batch]);
  const retryPredicate = recoveryV2
    ? `AND i.id = ANY(${recoveryIdsParam}::uuid[])
          AND i.metadata->>'parked_blocker' = 'runtime_evidence_unverified'
          AND EXISTS (
            SELECT 1 FROM agent_task_queue completed
             WHERE completed.issue_id = i.id AND completed.context->>'kind' = ${kindParam}
               AND LOWER(completed.status) = 'completed'
               AND completed.context->>'evidence_correction_retry' = 'true'
               AND completed.context->>'runtime_evidence_recovery_consumed' = 'true'
          )
          AND NOT EXISTS (
            SELECT 1 FROM agent_task_queue recovered
             WHERE recovered.issue_id = i.id AND recovered.context->>'kind' = ${kindParam}
               AND recovered.context->>'runtime_evidence_recovery_v2_requested' = 'true'
          )`
    : options.retryRuntimeEvidence
    ? `AND i.metadata->>'parked_blocker' = 'runtime_evidence_unverified'
          AND EXISTS (
            SELECT 1 FROM agent_task_queue completed
             WHERE completed.issue_id = i.id AND completed.context->>'kind' = ${kindParam}
               AND LOWER(completed.status) = 'completed'
          )
          AND NOT EXISTS (
            SELECT 1 FROM agent_task_queue retried
             WHERE retried.issue_id = i.id AND retried.context->>'kind' = ${kindParam}
               AND retried.context->>'evidence_correction_retry' = 'true'
          )`
    : `AND NOT EXISTS (
            SELECT 1 FROM agent_task_queue d
             WHERE d.issue_id = i.id AND d.context->>'kind' = ${kindParam}
               AND COALESCE(LOWER(d.status), '') NOT IN ('failed', 'cancelled')
          )`;
  const candidateSql =
    `WITH ranked AS (
       SELECT i.id, i.workspace_id,
              ROW_NUMBER() OVER (PARTITION BY i.workspace_id ORDER BY i.id) AS workspace_rank
         FROM issue i
        WHERE i.status = 'Parked' ${where}
          -- A folded child belongs to its open MEGA. It may remain Parked
          -- while the MEGA is being delivered, but must not consume a Sol
          -- diagnosis slot or re-enter the independent retry ladder.
          AND NOT EXISTS (
            SELECT 1 FROM issue mega
             WHERE mega.id = i.parent_issue_id
               AND mega.title LIKE 'MEGA%'
               AND mega.status NOT IN ('Done', 'Archived', 'Cancelled')
          )
          ${retryPredicate}
     )
     SELECT i.id, i.workspace_id, i.status, i.priority, i.metadata
       FROM issue i JOIN ranked r ON r.id = i.id
      ORDER BY r.workspace_rank, r.workspace_id, i.id
      LIMIT ${limitParam}`;
  const counts = { selected: 0, queued: 0, recovered_v2: 0, would_queue: 0, skipped_blocker: 0,
    skipped_existing: 0, skipped_completed: 0, skipped_failed: 0,
    skipped_cancelled: 0, skipped_no_owner: 0, stale: 0, failed: 0,
    scanned: 0, scan_limit: options.batch };
  const ids = { queued: [], recovered_v2: [], would_queue: [], skipped: [], skipped_blocker: [],
    skipped_existing: [], skipped_completed: [], skipped_failed: [],
    skipped_cancelled: [], skipped_no_owner: [], stale: [], failed: [] };
  if (options.mode === 'dry-run') {
    const listed = await pool.query(candidateSql, values);
    const rows = interleaveByWorkspace(listed.rows).slice(0, options.batch);
    counts.selected = rows.length;
    counts.scanned = rows.length;
    counts.would_queue = rows.length;
    ids.would_queue.push(...rows.map((row) => row.id));
    return { mode: options.mode, batch_size: options.batch, workspace: options.workspace, counts, ids };
  }

  const listed = await pool.query(candidateSql, values);
  const rows = interleaveByWorkspace(listed.rows).slice(0, options.batch);
  for (const listedIssue of rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query(
        `SELECT id, workspace_id, status, priority, metadata FROM issue
          WHERE id = $1 AND status = 'Parked' FOR UPDATE SKIP LOCKED`, [listedIssue.id]);
      if (!locked.rowCount) {
        counts.stale += 1;
        ids.stale.push(listedIssue.id);
        await client.query('ROLLBACK');
        continue;
      }
      const issue = locked.rows[0];
      counts.scanned += 1;
      counts.selected += 1;
      const decision = await inspect(client, issue, options);
      if (decision.kind === 'skip') {
        // A race can create a task after selection only when a non-cooperating
        // writer bypasses the issue lock. Record it but never create a second.
        counts.skipped_existing += 1;
        ids.skipped.push(issue.id);
        ids.skipped_existing.push(issue.id);
        continue;
      }
      if (decision.retrying === 'runtime_evidence_recovery_v2') {
        const recovered = await client.query(
          `UPDATE agent_task_queue
              SET context = COALESCE(context, '{}'::jsonb) ||
                    '{"runtime_evidence_recovery_v2_requested":true}'::jsonb
            WHERE id = $1::uuid AND status = 'completed'
              AND context->>'kind' = $2::text
              AND context->>'evidence_correction_retry' = 'true'
              AND context->>'runtime_evidence_recovery_consumed' = 'true'
              AND COALESCE(context->>'runtime_evidence_recovery_v2_requested', 'false') <> 'true'
            RETURNING id`, [decision.prior_task_id, PARK_DIAGNOSIS_KIND]);
        if (recovered.rowCount) {
          counts.recovered_v2 += 1;
          ids.recovered_v2.push(`${issue.id}:${recovered.rows[0].id}`);
        } else {
          counts.skipped_existing += 1;
          ids.skipped_existing.push(issue.id);
        }
        continue;
      }
      const selection = await recordParkAndQueueDiagnosis(client, issue, {
        reason: decision.has_reason_comment ? 'backfill_existing_reason' : 'backfill_reason_not_recoverable',
        skip_reason_comment: decision.has_reason_comment,
        evidence_correction_retry: decision.retrying === 'runtime_evidence_correction',
        retry_of_task_id: decision.prior_task_id
      });
      if (selection.task_id) { counts.queued += 1; ids.queued.push(`${issue.id}:${selection.task_id}`); }
      else {
        counts.skipped_no_owner += 1;
        ids.skipped_no_owner.push(issue.id);
      }
      await client.query('COMMIT');
    } catch (error) {
      counts.failed += 1;
      await client.query('ROLLBACK').catch(() => {});
      ids.failed.push({ issue_id: listedIssue.id, reason: failureReason(error) });
    } finally {
      client.release();
    }
  }
  return { mode: options.mode, batch_size: options.batch, workspace: options.workspace,
    counts, ids };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(usage()); return; }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  let Pool;
  try { ({ Pool } = require('pg')); }
  catch (error) {
    throw new Error(`pg dependency is required to run the backfill: ${error.message}`);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try { console.log(JSON.stringify(await run(pool, options))); } finally { await pool.end(); }
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = {
  MAX_BATCH, MAX_SCAN_WINDOW, NONTERMINAL, failureReason, interleaveByWorkspace, parseArgs, inspect, run, usage
};
