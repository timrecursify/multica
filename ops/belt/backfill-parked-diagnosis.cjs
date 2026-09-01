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
  const out = { batch: DEFAULT_BATCH, workspace: null, mode: null };
  let modeCount = 0;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run' || arg === '--apply') {
      out.mode = arg.slice(2);
      modeCount += 1;
    }
    else if (arg === '--batch-size') out.batch = Number(argv[++i]);
    else if (arg === '--workspace') out.workspace = argv[++i];
    else if (arg === '--help') return { help: true };
    else throw new Error(`unknown option: ${arg}`);
  }
  if (modeCount !== 1) throw new Error('exactly one of --dry-run or --apply is required');
  if (!Number.isInteger(out.batch) || out.batch < 1 || out.batch > MAX_BATCH) {
    throw new Error(`--batch-size must be an integer from 1 to ${MAX_BATCH}`);
  }
  return out;
}

function usage() {
  return 'Usage: backfill-parked-diagnosis.cjs (--dry-run|--apply) [--batch-size N] [--workspace UUID]';
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

async function inspect(client, issue) {
  const blocker = issue.metadata && typeof issue.metadata === 'object'
    ? issue.metadata.parked_blocker : null;
  const task = await client.query(
    `SELECT id, status FROM agent_task_queue
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
  const where = options.workspace ? 'AND i.workspace_id = $1' : '';
  const kindParam = options.workspace ? '$2' : '$1';
  const limitParam = options.workspace ? '$3' : '$2';
  const values = options.workspace
    ? [options.workspace, PARK_DIAGNOSIS_KIND, options.batch]
    : [PARK_DIAGNOSIS_KIND, options.batch];
  const candidateSql =
    `WITH ranked AS (
       SELECT i.id, i.workspace_id,
              ROW_NUMBER() OVER (PARTITION BY i.workspace_id ORDER BY i.id) AS workspace_rank
         FROM issue i
        WHERE i.status = 'Parked' ${where}
          AND NOT EXISTS (
            SELECT 1 FROM agent_task_queue d
             WHERE d.issue_id = i.id AND d.context->>'kind' = ${kindParam}
               AND COALESCE(LOWER(d.status), '') NOT IN ('failed', 'cancelled')
          )
     )
     SELECT i.id, i.workspace_id, i.status, i.priority, i.metadata
       FROM issue i JOIN ranked r ON r.id = i.id
      ORDER BY r.workspace_rank, r.workspace_id, i.id
      LIMIT ${limitParam}`;
  const counts = { selected: 0, queued: 0, would_queue: 0, skipped_blocker: 0,
    skipped_existing: 0, skipped_completed: 0, skipped_failed: 0,
    skipped_cancelled: 0, skipped_no_owner: 0, stale: 0, failed: 0,
    scanned: 0, scan_limit: options.batch };
  const ids = { queued: [], would_queue: [], skipped: [], skipped_blocker: [],
    skipped_existing: [], skipped_completed: [], skipped_failed: [],
    skipped_cancelled: [], skipped_no_owner: [], stale: [] };
  if (options.mode === 'dry-run') {
    const listed = await pool.query(candidateSql, values);
    const rows = interleaveByWorkspace(listed.rows).slice(0, options.batch);
    counts.selected = rows.length;
    counts.scanned = rows.length;
    counts.would_queue = rows.length;
    ids.would_queue.push(...rows.map((row) => row.id));
    return { mode: options.mode, batch_size: options.batch, workspace: options.workspace, counts, ids };
  }

  // The complete batch shares one transaction: an error rolls back every
  // comment, blocker, and task insert from this invocation. SKIP LOCKED lets
  // concurrent operators take distinct tickets without waiting or duplicating.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lockedSql = `${candidateSql} FOR UPDATE OF i SKIP LOCKED`;
    const listed = await client.query(lockedSql, values);
    const rows = interleaveByWorkspace(listed.rows).slice(0, options.batch);
    for (const issue of rows) {
      counts.scanned += 1;
      counts.selected += 1;
      const decision = await inspect(client, issue);
      if (decision.kind === 'skip') {
        // A race can create a task after selection only when a non-cooperating
        // writer bypasses the issue lock. Record it but never create a second.
        counts.skipped_existing += 1;
        ids.skipped.push(issue.id);
        ids.skipped_existing.push(issue.id);
        continue;
      }
      const taskId = await recordParkAndQueueDiagnosis(client, issue, {
        reason: decision.has_reason_comment ? 'backfill_existing_reason' : 'backfill_reason_not_recoverable',
        skip_reason_comment: decision.has_reason_comment
      });
      if (taskId) { counts.queued += 1; ids.queued.push(`${issue.id}:${taskId}`); }
      else {
        counts.skipped_no_owner += 1;
        ids.skipped_no_owner.push(issue.id);
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    counts.failed += 1;
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
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
  MAX_BATCH, MAX_SCAN_WINDOW, NONTERMINAL, interleaveByWorkspace, parseArgs, inspect, run, usage
};
