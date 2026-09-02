const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const { PARK_RUNTIME_VERIFICATION_KIND, firstDurableEvidence } = require('./parked-runtime-verification.cjs');

test('verification lane has a separate, bounded, non-diagnosis kind', () => {
  const source = fs.readFileSync(require.resolve('./parked-runtime-verification.cjs'), 'utf8');
  assert.equal(PARK_RUNTIME_VERIFICATION_KIND, 'parked_runtime_verification');
  assert.match(source, /LIMIT \$3/);
  assert.match(source, /FOR UPDATE SKIP LOCKED/);
  assert.match(source, /verification_processed/);
  assert.match(source, /runtime_evidence_unverified/);
  assert.match(source, /context->>'kind' IS DISTINCT FROM \$2/);
  assert.match(source, /runtime_evidence_verified/);
  assert.doesNotMatch(source, /recordParkAndQueueDiagnosis/);
});

test('only durable issue-scoped evidence is selected and diagnosis tasks are excluded', async () => {
  let sql = '';
  const ref = await firstDurableEvidence({ query: async (statement) => {
    sql = statement; return { rows: [{ ref: 'qc:42' }] };
  } }, '123e4567-e89b-12d3-a456-426614174000');
  assert.equal(ref, 'qc:42');
  assert.match(sql, /t\.issue_id = \$1::uuid/);
  assert.match(sql, /v\.issue_id = \$1::uuid/);
  assert.match(sql, /a\.issue_id = \$1::uuid/);
  assert.match(sql, /context->>'kind' IS DISTINCT FROM \$2/);
});
