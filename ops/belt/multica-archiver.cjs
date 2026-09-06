#!/usr/bin/env node
const http = require('http');
const crypto = require('crypto');
const { Pool } = require('pg');

const AGE_HOURS = 24;
const INTERVAL_MS = 15 * 60 * 1000;
const WORKSPACES = [
  'da3c5c5c-a123-4567-b999-c3ed1820da00',
  'f47e92d1-8c9e-4f2a-9b3c-7e2a4d1b5c6f',
];
const DATABASE_URL = process.env.DATABASE_URL;
const ARCHIVER_AGENT_SECRET = process.env.ARCHIVER_AGENT_SECRET;

if (!DATABASE_URL || !ARCHIVER_AGENT_SECRET) {
  throw new Error('DATABASE_URL and ARCHIVER_AGENT_SECRET are required');
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 1, application_name: 'multica-archiver' });

function advanceToArchived(issueID) {
  const payload = `archiver:${issueID}:Done->Archived`;
  const signedArchivePlanReceipt = `${payload}:${crypto.createHmac('sha256', ARCHIVER_AGENT_SECRET).update(payload).digest('hex')}`;
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ issue_id: issueID, to_stage: 'Archived', actor: 'archiver',
      evidence: { signedArchivePlanReceipt } });
    const request = http.request({
      hostname: '127.0.0.1', port: 5005, path: '/relay/advance', method: 'POST', timeout: 5000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
        'x-relay-archiver-secret': ARCHIVER_AGENT_SECRET },
    }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode === 200));
    });
    request.on('error', reject);
    request.on('timeout', () => { request.destroy(); reject(new Error('relay timeout')); });
    request.end(body);
  });
}

async function archiveDoneIssues() {
  const { rows } = await pool.query(
    `SELECT id FROM issue WHERE workspace_id = ANY($1::uuid[]) AND status = 'Done'
       AND updated_at <= NOW() - ($2::text || ' hours')::interval
     ORDER BY updated_at ASC LIMIT 100`, [WORKSPACES, String(AGE_HOURS)]);
  let archived = 0;
  for (const issue of rows) if (await advanceToArchived(issue.id)) archived += 1;
  console.log(`[multica-archiver] archived=${archived} candidates=${rows.length} threshold=${AGE_HOURS}h`);
}

async function run() {
  try { await archiveDoneIssues(); } catch (error) { console.error(`[multica-archiver] ${error.message}`); }
}

run();
setInterval(run, INTERVAL_MS);
