#!/usr/bin/env node

// One-shot operator backfill. It is intentionally separate from the live
// bridge: dry-run is read-only, apply is explicit, and each ticket is locked
// before the shared parking contract is called.
const { recordParkAndQueueDiagnosis, PARK_DIAGNOSIS_KIND } = require('./parked-diagnosis.cjs');

const DEFAULT_BATCH = 25;
const MAX_BATCH = 25;
// The operator may inspect at most four batches per invocation. This keeps
// stale/blocker rows from making the query unbounded while still allowing a
// normal batch to be filled after skipped rows.
const MAX_SCAN_WINDOW = MAX_BATCH * 4;
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
  if (blocker) return { kind: 'skip', reason: 'named_parked_blocker' };
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
    return { kind: 'skip',
      reason,
      status,
      task_id: task.rows[0].id };
  }
  const comment = await client.query(
    `SELECT 1 FROM comment WHERE issue_id = $1
      AND content LIKE '<!-- multica-park-reason -->%' LIMIT 1`, [issue.id]);
  return { kind: 'eligible', has_reason_comment: comment.rowCount > 0 };
}

async function run(pool, options) {
  const where = options.workspace ? 'AND workspace_id = $1' : '';
  const values = options.workspace ? [options.workspace, MAX_SCAN_WINDOW] : [MAX_SCAN_WINDOW];
  const limitParam = options.workspace ? '$2' : '$1';
  const listed = await pool.query(
    `WITH ranked AS (
       SELECT id, workspace_id, status, priority, metadata,
              ROW_NUMBER() OVER (PARTITION BY workspace_id ORDER BY id) AS workspace_rank
         FROM issue
        WHERE status = 'Parked' ${where}
     )
     SELECT id, workspace_id, status, priority, metadata
       FROM ranked
      WHERE workspace_rank <= ${limitParam}
      ORDER BY workspace_rank, workspace_id, id
      LIMIT ${limitParam}`, values);
  const counts = { selected: 0, queued: 0, would_queue: 0, skipped_blocker: 0,
    skipped_existing: 0, skipped_completed: 0, skipped_failed: 0,
    skipped_cancelled: 0, skipped_no_owner: 0, stale: 0, failed: 0,
    scanned: 0, scan_limit: MAX_SCAN_WINDOW };
  const ids = { queued: [], would_queue: [], skipped: [], skipped_blocker: [],
    skipped_existing: [], skipped_completed: [], skipped_failed: [],
    skipped_cancelled: [], skipped_no_owner: [], stale: [] };
  for (const listedIssue of interleaveByWorkspace(listed.rows)) {
    if (counts.selected >= options.batch) break;
    counts.scanned += 1;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query(
        `SELECT id, workspace_id, status, priority, metadata FROM issue
          WHERE id = $1 AND status = 'Parked' FOR UPDATE`, [listedIssue.id]);
      if (!locked.rowCount) {
        counts.stale += 1;
        ids.stale.push(listedIssue.id);
        await client.query('ROLLBACK');
        continue;
      }
      const issue = locked.rows[0];
      const decision = await inspect(client, issue);
      if (decision.kind === 'skip') {
        const category = decision.reason === 'named_parked_blocker' ? 'skipped_blocker'
          : decision.reason === 'completed_parked_diagnosis' ? 'skipped_completed'
            : decision.reason === 'failed_parked_diagnosis' ? 'skipped_failed'
              : decision.reason === 'cancelled_parked_diagnosis' ? 'skipped_cancelled'
                : 'skipped_existing';
        counts[category] += 1;
        ids.skipped.push(issue.id);
        ids[category].push(issue.id);
        await client.query('COMMIT');
        continue;
      }
      counts.selected += 1;
      if (options.mode === 'dry-run') {
        counts.would_queue += 1; ids.would_queue.push(issue.id);
        await client.query('ROLLBACK');
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
      await client.query('COMMIT');
    } catch (error) {
      counts.failed += 1;
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
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
