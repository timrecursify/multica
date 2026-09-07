const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
process.env.JWT_SECRET ||= 'test';
process.env.DATABASE_URL ||= 'postgres://test';
process.env.RELAY_AGENT_SECRET ||= 'relay';
process.env.MULTICA_WORKSPACE_ID ||= 'test-workspace';
const { mergedPrEvidence } = require('./multica-bridge.cjs');
const { durableCursor, recordCursor } = require('./merged-pr-recovery-sweep.cjs');

test('merged evidence fails before querying for a non-full SHA', async () => {
  const result = await mergedPrEvidence({ query: async () => { throw new Error('must not query'); } },
    { id: 'issue' }, { sha: 'deadbeef' });
  assert.deepEqual(result, { ok: false, reason: 'invalid_sha' });
});

const SHA = 'a'.repeat(40);
const issue = { id: 'issue', status: 'Queue' };
const linkedPr = { repository: 'timrecursify/multica', html_url: 'https://github.com/timrecursify/multica/pull/1', head_sha: SHA, merged_at: '2026-09-02T00:00:00Z' };
function verifierClient(rows) {
  const calls = [];
  return { calls, query: async (sql) => { calls.push(sql); return { rows }; } };
}
function gh(status = 'identical') {
  return (_bin, args) => args.includes('.default_branch') ? 'main\n' : `${status}\n`;
}

test('merged evidence accepts one canonical merged PR from every source stage without writes', async () => {
  for (const status of ['Spec', 'Queue', 'In Progress']) {
    const client = verifierClient([linkedPr]);
    const result = await mergedPrEvidence(client, { ...issue, status }, { sha: SHA }, { execFileSync: gh('ahead') });
    assert.equal(result.ok, true);
    assert.equal(client.calls.length, 1);
    assert.match(client.calls[0], /^SELECT/);
  }
});

test('merged evidence rejects absent, reference-only, and non-merged links', async () => {
  for (const rows of [[], [] /* reference-only/open/draft/closed-unmerged are SQL-filtered */]) {
    const result = await mergedPrEvidence(verifierClient(rows), issue, { sha: SHA }, { execFileSync: gh() });
    assert.deepEqual(result, { ok: false, reason: 'missing_linked_pr' });
  }
});

test('merged evidence rejects ambiguity, SHA mismatch, and default-branch misses', async () => {
  assert.deepEqual(await mergedPrEvidence(verifierClient([linkedPr, { ...linkedPr, html_url: linkedPr.html_url + '/2' }]), issue, { sha: SHA }, { execFileSync: gh() }), { ok: false, reason: 'ambiguous_linked_pr' });
  assert.deepEqual(await mergedPrEvidence(verifierClient([{ ...linkedPr, head_sha: 'b'.repeat(40) }]), issue, { sha: SHA }, { execFileSync: gh() }), { ok: false, reason: 'sha_mismatch' });
  assert.deepEqual(await mergedPrEvidence(verifierClient([linkedPr]), issue, { sha: SHA }, { execFileSync: gh('behind') }), { ok: false, reason: 'sha_not_on_default_branch' });
});

test('merged evidence fails closed on GitHub provider errors', async () => {
  const result = await mergedPrEvidence(verifierClient([linkedPr]), issue, { sha: SHA }, { execFileSync: () => { throw new Error('provider unavailable'); } });
  assert.deepEqual(result, { ok: false, reason: 'github_verification_failed' });
});

test('recovery cursor is stored durably in activity_log and restored after restart', async () => {
  const calls = [];
  const db = { query: async (sql, values) => {
    calls.push({ sql, values });
    if (sql.startsWith('SELECT details')) return { rows: [{ cursor: 'cursor-1' }] };
    return { rows: [] };
  } };
  assert.equal(await durableCursor(db), 'cursor-1');
  await recordCursor(db, 'cursor-2');
  assert.match(calls[0].sql, /activity_log/);
  assert.deepEqual(calls[1].values.slice(1), ['cursor-2']);
});

test('recovery worker is scheduled and deployable as a PM2 service', () => {
  const worker = fs.readFileSync(require.resolve('./merged-pr-recovery-sweep.cjs'), 'utf8');
  const ecosystem = fs.readFileSync(require.resolve('./ecosystem.gsp-belt.config.js'), 'utf8');
  const deploy = fs.readFileSync(require.resolve('./deploy.sh'), 'utf8');
  assert.match(worker, /setInterval\(\(\) => sweep\(\)/);
  assert.match(worker, /pg_advisory_xact_lock/);
  assert.match(ecosystem, /merged-pr-recovery-sweep/);
  assert.match(deploy, /merged-pr-recovery-sweep\.cjs/);
});
