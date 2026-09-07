const assert = require('node:assert/strict');
const test = require('node:test');
const { md5ForSha, runQcGate } = require('./qc-gate.cjs');

const SHA = 'a'.repeat(40);
const REPO = 'acme/widget';

test('independent QC GitHub reads overlap and use repository-SHA cache keys', async () => {
  const started = new Set();
  const calls = [];
  let release;
  const bothStarted = new Promise(resolve => { release = resolve; });
  const gh = async (args, options = {}) => {
    const path = args[1];
    calls.push({ path, cacheKey: options.cacheKey });
    if (path === `repos/${REPO}/pulls/7`) {
      return JSON.stringify({ head: { sha: SHA }, mergeable_state: 'clean' });
    }
    if (path.includes('/check-runs') || path.includes('/files?')) {
      started.add(path.includes('/check-runs') ? 'checks' : 'files');
      if (started.size === 2) release();
      await bothStarted;
      if (path.includes('/check-runs')) {
        return JSON.stringify({ check_runs: [{ name: 'test', status: 'completed', conclusion: 'success' }] });
      }
      return JSON.stringify([
        { filename: 'src/a.js', additions: 2, deletions: 0, status: 'modified', patch: '+safe' },
        { filename: 'src/a.test.js', additions: 2, deletions: 0, status: 'modified', patch: '+test' }
      ]);
    }
    if (path.includes('/contents/src/a.js')) {
      return JSON.stringify({ content: Buffer.from('line one\nline two\n').toString('base64') });
    }
    throw new Error(`unexpected GitHub read: ${path}`);
  };
  const result = await runQcGate({
    issue: { id: 'issue-1', metadata: { pr_url: `https://github.com/${REPO}/pull/7` } },
    workspace: { id: 'workspace-1' }, evidence: {}, gh,
    db: { query: async () => ({ rows: [] }) },
    workProduct: async () => 'b'.repeat(32)
  });
  assert.equal(result.verdict, 'PASS');
  assert.deepEqual([...started].sort(), ['checks', 'files']);
  assert.ok(calls.some(call => call.cacheKey === `${REPO}@${SHA}:check-runs`));
  assert.ok(calls.some(call => call.cacheKey === `${REPO}@${SHA}:pr-files`));
  assert.ok(calls.some(call => call.cacheKey === `${REPO}@${SHA}:content:src/a.js`));
});

test('work-product hashing performs one asynchronous tree read on a cache hit', async () => {
  const calls = [];
  const git = async args => {
    calls.push(args);
    return `100644 blob ${'c'.repeat(40)}\tsrc/a.js\n`;
  };
  const digest = await md5ForSha(SHA, { id: 'workspace-1', bareCache: '/cache' }, REPO, git);
  assert.match(digest, /^[0-9a-f]{32}$/);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(2, 5), ['ls-tree', '-r', '--full-tree']);
});
