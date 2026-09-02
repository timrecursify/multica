#!/usr/bin/env node
// Bounded recovery for tickets whose canonical PR was merged before the belt
// could route them to deploy. Verification remains in /relay/advance so this
// process cannot create an alternate authority path.
const fs = require('fs');
const http = require('http');
const LIMIT = Number(process.env.MERGED_PR_RECOVERY_LIMIT || 50);
const INTERVAL_MS = Number(process.env.MERGED_PR_RECOVERY_INTERVAL_MS || 300000);
const WORKSPACE_ID = process.env.MULTICA_WORKSPACE_ID || 'f47e92d1-8c9e-4f2a-9b3c-7e2a4d1b5c6f';
const envPath = process.env.MULTICA_REMOTE_BRIDGE_ENV || '/home/newadmin/.secrets/multica-remote/remote-bridge.env';
const env = fs.readFileSync(envPath, 'utf8');
const value = key => env.split('\n').find(line => line.startsWith(`${key}=`))?.slice(key.length + 1).trim();
const token = value('RELAY_AGENT_SECRET');
const operatorSecret = value('RELAY_OPERATOR_SECRET');
let pool;

function advance(issue, sha) {
  return new Promise(resolve => {
    const body = JSON.stringify({ issue_id: issue.id, to_stage: 'CI/CD & Deploy', agent_token: token,
      merged_pr_evidence: { sha } });
    const req = http.request('http://127.0.0.1:5005/relay/advance', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-relay-operator-secret': operatorSecret }, timeout: 20000 }, res => {
      let text = ''; res.on('data', part => text += part); res.on('end', () => resolve({ status: res.statusCode, body: text }));
    });
    req.on('error', error => resolve({ status: 0, body: error.message })); req.write(body); req.end();
  });
}

async function durableCursor(db) {
  const result = await db.query(`SELECT details->>'cursor' AS cursor FROM activity_log
    WHERE workspace_id=$1 AND issue_id IS NULL AND action='merged_pr_recovery_cursor'
    ORDER BY created_at DESC, id DESC LIMIT 1`, [WORKSPACE_ID]);
  return result.rows[0]?.cursor || '';
}
async function recordCursor(db, cursor) {
  await db.query(`INSERT INTO activity_log (workspace_id, actor_type, action, details)
    VALUES ($1, 'system', 'merged_pr_recovery_cursor', jsonb_build_object('cursor', $2::text))`,
    [WORKSPACE_ID, cursor]);
}
async function sweep(db = pool) {
  await db.query('BEGIN');
  try {
  await db.query("SELECT pg_advisory_xact_lock(hashtext('merged_pr_recovery_cursor'))");
  const cursor = await durableCursor(db);
  const candidates = await db.query(
    `WITH linked AS (
       SELECT link.issue_id, pr.head_sha
         FROM issue_pull_request link JOIN github_pull_request pr ON pr.id=link.pull_request_id
        WHERE NOT link.reference_only AND pr.state='merged' AND pr.merged_at IS NOT NULL
       UNION ALL
       SELECT link.issue_id, pr.head_sha
         FROM issue_vcs_pull_request link JOIN vcs_pull_request pr ON pr.id=link.pull_request_id
        WHERE NOT link.reference_only AND pr.state='merged' AND pr.merged_at IS NOT NULL
     ), qualifying AS (
       SELECT issue_id, min(head_sha) AS head_sha
         FROM linked
        GROUP BY issue_id HAVING count(*) = 1
          AND min(head_sha) ~ '^[0-9a-fA-F]{40}$'
     )
     SELECT i.id, i.number, q.head_sha
       FROM issue i JOIN qualifying q ON q.issue_id=i.id
      WHERE i.status = ANY(ARRAY['Spec','Queue','In Progress']) AND i.id::text > $2
        AND NOT EXISTS (SELECT 1 FROM agent_task_queue q WHERE q.issue_id=i.id
          AND q.status IN ('queued','dispatched','running','waiting_local_directory','deferred'))
      ORDER BY i.id LIMIT $1`, [LIMIT, cursor]);
  for (const issue of candidates.rows) {
    const result = await advance(issue, issue.head_sha);
    console.log(JSON.stringify({ event: 'merged_pr_recovery', issue_id: issue.id, number: issue.number,
      sha: issue.head_sha, status: result.status, outcome: result.body.slice(0, 240) }));
  }
  const nextCursor = candidates.rows.length < LIMIT ? '' : candidates.rows.at(-1).id;
  await recordCursor(db, nextCursor);
  await db.query('COMMIT');
  console.log(JSON.stringify({ event: 'merged_pr_recovery_cursor', next_cursor: nextCursor,
    exhausted: candidates.rows.length < LIMIT }));
  } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; }
}
function initializeRuntime() {
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: value('DATABASE_URL'), max: 1,
    application_name: 'merged-pr-recovery-sweep' });
}
if (require.main === module) {
  initializeRuntime();
  sweep().catch(error => console.error('[merged-pr-recovery]', error.message));
  setInterval(() => sweep().catch(error => console.error('[merged-pr-recovery]', error.message)), INTERVAL_MS);
}
module.exports = { sweep, durableCursor, recordCursor };
