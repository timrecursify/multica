#!/usr/bin/env node

// One-shot operator backfill. It is intentionally separate from the live
// bridge: dry-run is read-only, apply is explicit, and each ticket is locked
// before the shared parking contract is called.
const { Pool } = require('pg');
const { recordParkAndQueueDiagnosis, PARK_DIAGNOSIS_KIND } = require('./parked-diagnosis.cjs');

const DEFAULT_BATCH = 25;
const MAX_BATCH = 25;
const NONTERMINAL = ['queued', 'dispatched', 'running', 'waiting_local_directory', 'deferred'];

function parseArgs(argv) {
  const out = { batch: DEFAULT_BATCH, workspace: null, mode: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run' || arg === '--apply') out.mode = arg.slice(2);
    else if (arg === '--batch-size') out.batch = Number(argv[++i]);
    else if (arg === '--workspace') out.workspace = argv[++i];
    else if (arg === '--help') return { help: true };
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!out.mode) throw new Error('exactly one of --dry-run or --apply is required');
  if (!Number.isInteger(out.batch) || out.batch < 1 || out.batch > MAX_BATCH) {
    throw new Error(`--batch-size must be an integer from 1 to ${MAX_BATCH}`);
  }
  return out;
}

function usage() {
  return 'Usage: backfill-parked-diagnosis.cjs (--dry-run|--apply) [--batch-size N] [--workspace UUID]';
}

async function inspect(client, issue) {
  const blocker = issue.metadata && typeof issue.metadata === 'object'
    ? issue.metadata.parked_blocker : null;
  if (blocker) return { kind: 'skip', reason: 'named_parked_blocker' };
  const task = await client.query(
    `SELECT id FROM agent_task_queue
      WHERE issue_id = $1 AND status = ANY($2::text[])
        AND context->>'kind' = $3 LIMIT 1`, [issue.id, NONTERMINAL, PARK_DIAGNOSIS_KIND]);
  if (task.rowCount) return { kind: 'skip', reason: 'nonterminal_parked_diagnosis', task_id: task.rows[0].id };
  const comment = await client.query(
    `SELECT 1 FROM comment WHERE issue_id = $1
      AND content LIKE '<!-- multica-park-reason -->%' LIMIT 1`, [issue.id]);
  return { kind: 'eligible', has_reason_comment: comment.rowCount > 0 };
}

async function run(pool, options) {
  const where = options.workspace ? 'AND workspace_id = $2' : '';
  const params = options.workspace ? [options.batch, options.workspace] : [options.batch];
  const listed = await pool.query(
    `SELECT id, workspace_id, status, priority, metadata
       FROM issue WHERE status = 'Parked' ${where}
      ORDER BY workspace_id, id LIMIT $1`, params);
  const counts = { selected: 0, queued: 0, would_queue: 0, skipped_blocker: 0,
    skipped_existing: 0, stale: 0, failed: 0 };
  const ids = { queued: [], would_queue: [], skipped: [] };
  for (const listedIssue of listed.rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query(
        `SELECT id, workspace_id, status, priority, metadata FROM issue
          WHERE id = $1 AND status = 'Parked' FOR UPDATE`, [listedIssue.id]);
      if (!locked.rowCount) { counts.stale += 1; await client.query('ROLLBACK'); continue; }
      const issue = locked.rows[0];
      const decision = await inspect(client, issue);
      if (decision.kind === 'skip') {
        counts[decision.reason === 'named_parked_blocker' ? 'skipped_blocker' : 'skipped_existing'] += 1;
        ids.skipped.push(issue.id);
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
      else counts.skipped_blocker += 1;
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
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try { console.log(JSON.stringify(await run(pool, options))); } finally { await pool.end(); }
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { MAX_BATCH, NONTERMINAL, parseArgs, inspect, run, usage };
