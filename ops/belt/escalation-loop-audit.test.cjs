const assert = require('node:assert/strict');
const test = require('node:test');
const { AUDIT_SQL, GSP, marker, classify, summarise, markdown } = require('./escalation-loop-audit.cjs');

test('audit retains the canonical budget predicate and historical relay-task join', () => {
  assert.match(AUDIT_SQL, /t\.context->>'to_stage' IS DISTINCT FROM 'In Review'/);
  assert.match(AUDIT_SQL, /t\.status IS DISTINCT FROM 'completed'/);
  assert.match(AUDIT_SQL, /verdict\.created_at >= t\.started_at/);
  assert.match(AUDIT_SQL, /relay_task_id=/);
  assert.match(AUDIT_SQL, /WHERE task_id = t\.id/);
  assert.match(AUDIT_SQL, /parked_audit->>'reason' = 'escalation_loop'/);
});

test('defect precedence, genuine classification, and exception preservation are explicit', () => {
  const base = { relay_status: 'completed', attempt_verdict: 'FAIL', output: '' };
  assert.equal(classify({ ...base, relay_status: 'failed' }), 'defect');
  assert.equal(classify({ ...base, attempt_verdict: null }), 'defect');
  assert.equal(classify(base), 'genuine');
  assert.equal(classify({ ...base, attempt_verdict: 'PASS' }), 'exception');
  assert.equal(marker('QC_EVIDENCE_JSON={bad}'), null);
  const evidence = { verdict: 'FAIL', work_product_md5: 'a'.repeat(32), bound_sha: 'b'.repeat(40),
    observed_sha: 'b'.repeat(40), failure_class: 'implementation', qualifying: true,
    model: 'gpt-5.6-sol', effort: 'low' };
  assert.equal(marker(`QC_EVIDENCE_JSON=${JSON.stringify(evidence)}`).verdict, 'FAIL');
});

test('markdown refuses a wrong population before producing a recommendation', () => {
  assert.throws(() => markdown('2026-09-02T00:00:00Z', []), /population discrepancy/);
  const rows = summarise([{ workspace_id: GSP, number: 1, task_id: 't', relay_status: 'completed', attempt_verdict: null }]);
  assert.equal(rows[0].defect, 1);
  const fullPopulation = [
    ...Array.from({ length: 65 }, (_, number) => ({ workspace: 'GSP', issue: number + 1, countable: 1,
      defect: 1, genuine: 0, exceptions: [] })),
    ...Array.from({ length: 29 }, (_, number) => ({ workspace: 'PPP', issue: number + 1, countable: 1,
      defect: 0, genuine: 1, exceptions: [] }))
  ];
  const report = markdown('2026-09-02T00:00:00Z', fullPopulation);
  assert.match(report, /Zero genuine FAILs: GSP-1/);
  assert.match(report, /Defect-majority mixed: none/);
  assert.match(report, /Genuine-majority\/equal mixed: PPP-1/);
  assert.match(report, /Exceptions: none\. Recommendation: keep the cap at 2\/6/);
});
