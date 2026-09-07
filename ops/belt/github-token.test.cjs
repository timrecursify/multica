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
