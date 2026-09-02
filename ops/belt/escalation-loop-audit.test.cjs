const assert = require('node:assert/strict');
const test = require('node:test');
const { AUDIT_SQL, GSP, marker, classify, summarise, markdown } = require('./escalation-loop-audit.cjs');

test('audit retains the canonical budget predicate and historical relay-task join', () => {
  assert.match(AUDIT_SQL, /t\.context->>'to_stage' IS DISTINCT FROM 'In Review'/);
  assert.match(AUDIT_SQL, /t\.status IS DISTINCT FROM 'completed'/);
  assert.match(AUDIT_SQL, /verdict\.created_at >= t\.started_at/);
  assert.match(AUDIT_SQL, /relay_task_id=/);
  assert.match(AUDIT_SQL, /parked_audit->>'reason' = 'escalation_loop'/);
});

test('defect precedence, genuine classification, and exception preservation are explicit', () => {
  const base = { task_status: 'completed', attempt_verdict: 'FAIL', output: '' };
  assert.equal(classify({ ...base, task_status: 'failed' }), 'defect');
  assert.equal(classify({ ...base, attempt_verdict: null }), 'defect');
  assert.equal(classify(base), 'genuine');
  assert.equal(classify({ ...base, attempt_verdict: 'PASS' }), 'exception');
  assert.equal(marker('QC_EVIDENCE_JSON={bad}'), null);
  assert.equal(marker('QC_EVIDENCE_JSON={"verdict":"FAIL"}').verdict, 'FAIL');
});

test('markdown refuses a wrong population before producing a recommendation', () => {
  assert.throws(() => markdown('2026-09-02T00:00:00Z', []), /population discrepancy/);
  const rows = summarise([{ workspace_id: GSP, number: 1, task_id: 't', task_status: 'completed', attempt_verdict: null }]);
  assert.equal(rows[0].defect, 1);
});
