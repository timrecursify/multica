const assert = require('node:assert/strict');
const test = require('node:test');
const { parseArgs, reserveRecovery, recover } = require('./recover-in-review-qc.cjs');
const issue = '123e4567-e89b-12d3-a456-426614174000'; const task = '223e4567-e89b-12d3-a456-426614174000';
test('requires exact operator UUIDs', () => {
  assert.deepEqual(parseArgs(['--apply', '--issue', issue, '--failed-task', task]), { apply: true, issueId: issue, failedTaskId: task });
  assert.throws(() => parseArgs(['--apply', '--issue', issue]), /failed-task UUID/);
});
test('DB gate is exact and has no direct issue status mutation', async () => {
  const source = require('node:fs').readFileSync(require.resolve('./recover-in-review-qc.cjs'), 'utf8');
  for (const text of ["i.status = 'Parked'", "failed.issue_id = i.id", "failed.failure_reason = 'cancelled'", "failed.started_at IS NOT NULL", "failed.completed_at IS NOT NULL", "u.task_id = failed.id", "cfg.next_stage = 'In Review'", "'gpt-5.6-sol'", "'low'", "'evidence_correction_retry'", "live.context->>'to_stage' = 'In Review'", "runtime_evidence_verified:"]) assert.match(source, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(source, /SET status =/);
  let writes = 0; const client = { query: async (sql) => { if (/^UPDATE issue/.test(sql.trim())) writes++; return { rows: [], rowCount: 0 }; } };
  assert.equal(await reserveRecovery(client, issue, task, async () => true), null); assert.equal(writes, 0);
});
test('relay failure clears release flag but retains recovery marker', async () => {
  const calls = []; let read = true;
  const client = { query: async (sql) => { calls.push(sql); if (read) { read = false; return { rows: [{ id: issue, diagnosis_id: task, diagnosis_result: 'runtime_evidence: task:323e4567-e89b-12d3-a456-426614174000' }], rowCount: 1 }; } return { rows: [{ id: issue }], rowCount: 1 }; } };
  await assert.rejects(recover(client, issue, task, { verifyRuntimeEvidence: async () => true, relayAdvance: async () => ({ ok: false, status: 503 }) }), /relay rejected/);
  assert.match(calls.at(-1), /- 'parked_release_once'/); assert.doesNotMatch(calls.at(-1), /- 'parked_qc_recovery'/);
});
