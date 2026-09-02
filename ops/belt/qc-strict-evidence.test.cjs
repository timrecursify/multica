const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const { currentStrictPass, STRICT_CURRENT_PASS_SQL, strictEvidenceFromRow } = require('./qc-strict-evidence.cjs');

test('strict evidence requires a bound attempt, completed relay task, and Sol-low lane', async () => {
  assert.match(STRICT_CURRENT_PASS_SQL, /qa\.bound_sha ~\* '\^\[0-9a-f\]\{40\}\$'/);
  assert.match(STRICT_CURRENT_PASS_SQL, /lower\(qa\.bound_sha\)=lower\(qa\.observed_head\)/);
  assert.match(STRICT_CURRENT_PASS_SQL, /t\.status='completed'/);
  assert.match(STRICT_CURRENT_PASS_SQL, /a\.model='gpt-5\.6-sol'/);
  const db = { query: async () => ({ rows: [] }) };
  assert.equal(await currentStrictPass(db, 'issue'), null);
});

test('row evidence rejects a note-only or mismatched attempt', () => {
  const row = { qc_attempt_verdict: 'PASS', qc_attempt_qualifying: true,
    qc_attempt_work_product_md5: 'a'.repeat(32), qc_attempt_bound_sha: 'b'.repeat(40),
    qc_attempt_observed_sha: 'b'.repeat(40), qc_attempt_evidence_agent_id: 'qc',
    qc_verdict_checker_id: 'qc', qc_attempt_evidence_agent_model: 'gpt-5.6-sol',
    qc_attempt_evidence_agent_effort: 'low' };
  assert.equal(strictEvidenceFromRow(row, 'a'.repeat(32)).ok, true);
  assert.equal(strictEvidenceFromRow({ ...row, qc_attempt_observed_sha: 'c'.repeat(40) }, 'a'.repeat(32)).reason,
    'qc_attempt_binding_required');
});

test('binding migration fails closed with a stable reason', () => {
  const migration = fs.readFileSync(require.resolve('../../server/migrations/303_qc_attempt_binding_required.up.sql'), 'utf8');
  assert.match(migration, /qc_attempt_binding_required/);
  assert.match(migration, /CREATE TRIGGER qc_verdict_attempt_binding/);
});
