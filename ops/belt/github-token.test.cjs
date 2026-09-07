const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tokenModule = require('./github-token.cjs');

test('mints the first helper output line and extracts repository names', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'github-token-'));
  const helper = path.join(dir, 'helper.cjs');
  fs.writeFileSync(helper, "#!/usr/bin/env node\nprocess.stdout.write('fake-installation-token\\nignored\\n');\n");
  fs.chmodSync(helper, 0o755);
  const previous = process.env.GSP_BELT_GIT_CREDENTIAL;
  process.env.GSP_BELT_GIT_CREDENTIAL = helper;
  try {
    assert.equal(tokenModule.mintGithubToken('multica'), 'fake-installation-token');
    assert.equal(tokenModule.repoFromGhArgs(['api', '-i', 'repos/timrecursify/multica/pulls/1']), 'multica');
  } finally {
    if (previous === undefined) delete process.env.GSP_BELT_GIT_CREDENTIAL;
    else process.env.GSP_BELT_GIT_CREDENTIAL = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('returns an empty token when the helper exits non-zero', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'github-token-'));
  const helper = path.join(dir, 'helper.cjs');
  fs.writeFileSync(helper, '#!/usr/bin/env node\nprocess.exit(7);\n');
  fs.chmodSync(helper, 0o755);
  const previous = process.env.GSP_BELT_GIT_CREDENTIAL;
  process.env.GSP_BELT_GIT_CREDENTIAL = helper;
  try {
    assert.doesNotThrow(() => assert.equal(tokenModule.mintGithubToken('multica'), ''));
  } finally {
    if (previous === undefined) delete process.env.GSP_BELT_GIT_CREDENTIAL;
    else process.env.GSP_BELT_GIT_CREDENTIAL = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The helper caches under $HOME/.cache and runs `set -euo pipefail`, so a unit
// whose ProtectSystem=strict sandbox leaves $HOME read-only loses an already
// minted token to the failed cache write. multica-cicd-worker lost every
// cold-cache `gh` call that way and fell back to an unauthenticated CLI.
function freshTokenModule() {
  delete require.cache[require.resolve('./github-token.cjs')];
  return require('./github-token.cjs');
}

test('falls back to a writable cache home when $HOME cannot hold the token cache', (t) => {
  if (process.getuid && process.getuid() === 0) return t.skip('root ignores the read-only mode');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'github-token-'));
  const home = path.join(dir, 'home');
  const receipts = path.join(dir, 'receipts');
  fs.mkdirSync(home);
  fs.mkdirSync(receipts);
  const helper = path.join(dir, 'helper.cjs');
  // Stands in for the real helper: it mints only where it can write
  // $HOME/.cache, and exits non-zero otherwise.
  fs.writeFileSync(helper, [
    '#!/usr/bin/env node',
    "const hfs = require('fs'); const hpath = require('path');",
    "try { hfs.writeFileSync(hpath.join(process.env.HOME, '.cache', 'token'), 'x'); }",
    'catch (error) { process.exit(1); }',
    "process.stdout.write('scoped-installation-token\\n');",
  ].join('\n'));
  fs.chmodSync(helper, 0o755);
  fs.chmodSync(home, 0o555);
  const previous = {
    helper: process.env.GSP_BELT_GIT_CREDENTIAL,
    home: process.env.HOME,
    receipts: process.env.MULTICA_RECEIPT_ROOT,
  };
  process.env.GSP_BELT_GIT_CREDENTIAL = helper;
  process.env.HOME = home;
  process.env.MULTICA_RECEIPT_ROOT = receipts;
  try {
    assert.equal(freshTokenModule().mintGithubToken('sk-cli'), 'scoped-installation-token');
    assert.equal(fs.existsSync(path.join(receipts, '.cache', 'token')), true);
  } finally {
    for (const [key, value] of [['GSP_BELT_GIT_CREDENTIAL', previous.helper],
      ['HOME', previous.home], ['MULTICA_RECEIPT_ROOT', previous.receipts]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.chmodSync(home, 0o755);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
