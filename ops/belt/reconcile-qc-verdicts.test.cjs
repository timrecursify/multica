const assert = require('node:assert/strict');
const test = require('node:test');
const { parseArgs, LEGACY_SQL, reconcile } = require('./reconcile-qc-verdicts.cjs');

const sha = 'a'.repeat(40);
const matchedRow = { issue_id: 'issue-1', verdict_id: 'verdict-1', checker_name: 'checker',
  work_product_md5: 'b'.repeat(32), match_count: 1, task_id: 'task-1', agent_name: 'sol',
  result: { bound_sha: sha, observed_sha: sha } };

function clientFor(rows) {
  const queries = [];
  return { queries, query: async (sql, params) => {
    queries.push({ sql, params });
    if (sql === LEGACY_SQL) return { rows };
    if (sql.includes('FROM qc_verdict v JOIN qc_attempt')) return { rows: [] };
    return { rows: [] };
  } };
}

test('reconciliation is dry-run by default and only accepts explicit apply', () => {
  assert.deepEqual(parseArgs([]), { mode: 'dry-run' });
  assert.deepEqual(parseArgs(['--apply']), { mode: 'apply' });
  assert.throws(() => parseArgs(['--apply', '--dry-run']));
  assert.match(LEGACY_SQL, /t\.result->>'bound_sha'/);
  assert.match(LEGACY_SQL, /t\.result->>'work_product_md5'=v\.work_product_md5/);
  assert.match(LEGACY_SQL, /count\(\*\)::int AS match_count/);
});

test('exact structured match rebounds into one qualifying attempt', async () => {
  const client = clientFor([matchedRow]);
  await reconcile(client, { mode: 'apply' });
  const insert = client.queries.find(({ sql }) => sql.includes('INSERT INTO qc_attempt'));
  assert.ok(insert);
  assert.deepEqual(insert.params.slice(0, 5), ['issue-1', 'sol', 'b'.repeat(32), sha, sha]);
  assert.ok(client.queries.some(({ sql }) => sql === 'COMMIT'));
});

test('zero or multiple structured matches are quarantined', async () => {
  const client = clientFor([
    { ...matchedRow, verdict_id: 'zero', match_count: 0, task_id: null, result: null },
    { ...matchedRow, verdict_id: 'many', match_count: 2 },
  ]);
  const result = await reconcile(client, { mode: 'apply' });
  assert.deepEqual(result.receipts.map(({ verdict_id, action }) => ({ verdict_id, action })), [
    { verdict_id: 'zero', action: 'quarantined' }, { verdict_id: 'many', action: 'quarantined' },
  ]);
  assert.equal(client.queries.filter(({ sql }) => sql.includes('UPDATE qc_verdict')).length, 2);
  assert.equal(client.queries.filter(({ sql }) => sql.includes('INSERT INTO qc_attempt')).length, 0);
});

test('receipt identifies the exact rebound decision', async () => {
  const result = await reconcile(clientFor([matchedRow]), { mode: 'dry-run' });
  assert.deepEqual(result, { mode: 'dry-run', receipts: [{ issue_id: 'issue-1',
    verdict_id: 'verdict-1', action: 'rebound', task_id: 'task-1' }] });
});

test('replay uses a stable idempotence key', async () => {
  const first = clientFor([matchedRow]);
  const second = clientFor([matchedRow]);
  await reconcile(first, { mode: 'apply' });
  await reconcile(second, { mode: 'apply' });
  const key = (client) => client.queries.find(({ sql }) => sql.includes('INSERT INTO qc_attempt')).params[5];
  assert.equal(key(first), 'reconcile-qc-verdict:verdict-1');
  assert.equal(key(second), key(first));
});
