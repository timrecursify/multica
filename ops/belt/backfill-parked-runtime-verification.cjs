#!/usr/bin/env node
// Explicit operator entry point for the verification-only cohort. Dry run is
// read-only; apply delegates to the same non-model relay processor.
const { Pool } = require('pg');
const http = require('http');
const { DEFAULT_BATCH, PARK_RUNTIME_VERIFICATION_KIND, processParkedRuntimeVerifications } = require('./parked-runtime-verification.cjs');

function parseArgs(argv) {
  const out = { mode: null, workspace: null, batch: DEFAULT_BATCH };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dry-run' || argv[i] === '--apply') {
      if (out.mode) throw new Error('exactly one of --dry-run or --apply is required');
      out.mode = argv[i].slice(2);
    } else if (argv[i] === '--workspace') out.workspace = argv[++i];
    else if (argv[i] === '--batch-size') out.batch = Number(argv[++i]);
    else throw new Error(`unknown option: ${argv[i]}`);
  }
  if (!out.mode || !out.workspace) throw new Error('--workspace and exactly one of --dry-run or --apply are required');
  if (!Number.isInteger(out.batch) || out.batch < 1 || out.batch > DEFAULT_BATCH) throw new Error(`--batch-size must be 1 to ${DEFAULT_BATCH}`);
  return out;
}

async function run(pool, options, relayPost) {
  const selected = await pool.query(`SELECT i.id FROM issue i WHERE i.workspace_id = $1::uuid AND i.status = 'Parked'
    AND i.metadata->>'parked_blocker' = 'runtime_evidence_unverified'
    AND EXISTS (SELECT 1 FROM agent_task_queue d WHERE d.issue_id = i.id AND d.status = 'completed'
      AND d.context->>'kind' = 'parked_diagnosis' AND lower(COALESCE(d.result::text, '')) ~ 'already_fixed')
    AND NOT EXISTS (SELECT 1 FROM agent_task_queue v WHERE v.issue_id = i.id
      AND v.context->>'kind' = '${PARK_RUNTIME_VERIFICATION_KIND}'
      AND v.context->>'verification_processed' = 'true') ORDER BY i.id LIMIT $2`, [options.workspace, options.batch]);
  const ids = selected.rows.map(r => r.id);
  const receipt = { mode: options.mode, workspace: options.workspace, counts: { selected: selected.rowCount, writes: 0 }, ids };
  if (options.mode === 'apply' && selected.rowCount) {
    receipt.counts.writes = (await processParkedRuntimeVerifications({ verificationPool: pool, relayPost,
      workspaceId: options.workspace, issueIds: ids, batch: options.batch })).writes;
  }
  return receipt;
}

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2));
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const relayPost = (payload) => new Promise((resolve, reject) => {
    const body = JSON.stringify({ ...payload, agent_token: process.env.RELAY_AGENT_SECRET });
    const request = http.request({ hostname: '127.0.0.1', port: 5005, path: '/relay/advance', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, response => {
      response.resume(); response.on('end', () => resolve({ ok: response.statusCode === 200, status: response.statusCode }));
    });
    request.on('error', reject); request.end(body);
  });
  run(pool, options, relayPost).then(r => console.log(JSON.stringify(r))).finally(() => pool.end());
}
module.exports = { parseArgs, run };
