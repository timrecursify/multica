const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { mintGithubToken, repoFromGhArgs } = require('./github-token.cjs');

function helper(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'github-token-'));
  const file = path.join(dir, 'helper.cjs');
  fs.writeFileSync(file, `#!/usr/bin/env node\n${contents}`);
  fs.chmodSync(file, 0o755);
  return file;
}

test('mintGithubToken returns the helper token and extracts repositories', () => {
  const previous = process.env.GSP_BELT_GIT_CREDENTIAL;
  process.env.GSP_BELT_GIT_CREDENTIAL = helper("process.stdout.write('fake-installation-token\\nextra\\n')");
  try {
    assert.equal(mintGithubToken('timrecursify/multica'), 'fake-installation-token');
    assert.equal(repoFromGhArgs(['api', 'repos/timrecursify/multica/pulls/42']), 'multica');
    assert.equal(repoFromGhArgs(['pr', 'view', '42', '-R', 'timrecursify/multica']), 'multica');
  } finally {
    if (previous === undefined) delete process.env.GSP_BELT_GIT_CREDENTIAL;
    else process.env.GSP_BELT_GIT_CREDENTIAL = previous;
  }
});

test('mintGithubToken degrades to an empty token when helper fails', () => {
  const previous = process.env.GSP_BELT_GIT_CREDENTIAL;
  process.env.GSP_BELT_GIT_CREDENTIAL = helper("process.exit(7)");
  try { assert.equal(mintGithubToken('timrecursify/multica'), ''); }
  finally {
    if (previous === undefined) delete process.env.GSP_BELT_GIT_CREDENTIAL;
    else process.env.GSP_BELT_GIT_CREDENTIAL = previous;
  }
});
