const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const { currentStrictPass, STRICT_CURRENT_PASS_SQL, strictEvidenceFromRow } = require('./qc-strict-evidence.cjs');

test('strict evidence requires a bound attempt, completed relay task, and Sol-low lane', async () => {
  assert.match(STRICT_CURRENT_PASS_SQL, /FROM qc_effective_verdict e/);
  assert.match(STRICT_CURRENT_PASS_SQL, /e\.bound_sha ~\* '\^\[0-9a-f\]\{40\}\$'/);
  assert.match(STRICT_CURRENT_PASS_SQL, /lower\(e\.bound_sha\)=lower\(e\.observed_head\)/);
  assert.match(STRICT_CURRENT_PASS_SQL, /t\.status='completed'/);
  assert.match(STRICT_CURRENT_PASS_SQL, /a\.model = ANY\(\$2::text\[\]\)/);
  const calls = [];
  const db = { query: async (...args) => (calls.push(args), { rows: [] }) };
  assert.equal(await currentStrictPass(db, 'issue'), null);
  assert.deepEqual(calls[0][1], ['issue', ['gpt-5.6-sol', 'gpt-5.6-luna'], 'low']);
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

test('event migration makes attempts immutable and derives one effective verdict', () => {
  const migration = fs.readFileSync(require.resolve('./sql/2026-09-07_qc_verdict_events.sql'), 'utf8');
  const rollback = fs.readFileSync(require.resolve('./sql/2026-09-07_qc_verdict_events.rollback.sql'), 'utf8');
  assert.match(migration, /source_idem_key/);
  assert.match(migration, /CREATE OR REPLACE VIEW public\.qc_effective_verdict/);
  assert.match(migration, /scope_revision DESC/);
  assert.match(migration, /post_gate_disposition/);
  assert.match(migration, /CASE verdict WHEN 'FAIL' THEN 1 ELSE 0 END DESC/);
  assert.match(migration, /BEFORE UPDATE OR DELETE ON public\.qc_attempt/);
  assert.match(rollback, /DROP VIEW IF EXISTS public\.qc_effective_verdict/);
});
