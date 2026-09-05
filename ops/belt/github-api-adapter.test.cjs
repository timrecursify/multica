'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGithubApi, createRateLimitState } = require('./github-api-adapter.cjs');

test('installation token is selected and real response headers trigger one sentinel', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gh-adapter-')), 'state.json');
  const calls = []; const alerts = [];
  const run = (args, options) => {
    calls.push({ args, options });
    if (args[0] === 'api' && args.includes('app/installations/7/access_tokens'))
      return 'HTTP/1.1 201 Created\n\n{"token":"installation-token"}';
    return 'HTTP/1.1 200 OK\nX-RateLimit-Remaining: 499\nX-RateLimit-Reset: 2000000000\n\n{"ok":true}';
  };
  const api = createGithubApi({ env: { GITHUB_APP_INSTALLATION_TOKEN: 'installation-token' }, run,
    state: createRateLimitState({ file, alert: value => alerts.push(value) }), now: () => 1000000000000 });
  // The fake token endpoint avoids signing; this assertion still proves the
  // normal API call receives GH_TOKEN from the installation exchange.
  api.api('repos/acme/repo', []);
  assert.equal(calls.at(-1).options.env.GH_TOKEN, 'installation-token');
  assert.equal(alerts.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).remaining, 499);
});

test('a second adapter observes the shared cooldown without calling GitHub', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gh-adapter-')), 'state.json');
  const state = createRateLimitState({ file, alert: () => {} });
  state.hold(Date.now() + 60000, 0, Date.now() + 60000);
  let calls = 0;
  const api = createGithubApi({ env: { GITHUB_APP_INSTALLATION_TOKEN: 'token' }, run: () => { calls += 1; return ''; }, state });
  assert.throws(() => api.api('repos/acme/repo'), /cooldown/);
  assert.equal(calls, 0);
});
