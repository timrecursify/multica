#!/usr/bin/env node
// Bounded recovery for tickets whose canonical PR was merged before the belt
// could route them to deploy. Verification remains in /relay/advance so this
// process cannot create an alternate authority path.
const fs = require('fs');
const http = require('http');
const { Pool } = require('pg');
const LIMIT = Number(process.env.MERGED_PR_RECOVERY_LIMIT || 50);
const cursor = process.env.MERGED_PR_RECOVERY_CURSOR || '';
const envPath = process.env.MULTICA_REMOTE_BRIDGE_ENV || '/home/newadmin/.secrets/multica-remote/remote-bridge.env';
const env = fs.readFileSync(envPath, 'utf8');
const value = key => env.split('\n').find(line => line.startsWith(`${key}=`))?.slice(key.length + 1).trim();
const token = value('RELAY_AGENT_SECRET');
const operatorSecret = value('RELAY_OPERATOR_SECRET');
const pool = new Pool({ connectionString: value('DATABASE_URL') });

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

async function sweep() {
  const candidates = await pool.query(
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
  console.log(JSON.stringify({ event: 'merged_pr_recovery_cursor',
    next_cursor: candidates.rows.at(-1)?.id || cursor, exhausted: candidates.rows.length < LIMIT }));
}
if (require.main === module) sweep().finally(() => pool.end());
module.exports = { sweep };
