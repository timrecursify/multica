'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGithubApi, createRateLimitState, createTtlCache } = require('./github-api-adapter.cjs');

test('installation token is selected and real response headers trigger one sentinel', async () => {
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
  await api.api('repos/acme/repo', []);
  assert.equal(calls.at(-1).options.env.GH_TOKEN, 'installation-token');
  assert.equal(alerts.length, 1);
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(Object.values(stored.scopes)[0].remaining, 499);
});

test('a second adapter observes the shared cooldown without calling GitHub', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gh-adapter-')), 'state.json');
  const state = createRateLimitState({ file, alert: () => {} });
  state.hold(Date.now() + 60000, 0, Date.now() + 60000);
  let calls = 0;
  const api = createGithubApi({ env: { GITHUB_APP_INSTALLATION_TOKEN: 'token' }, run: () => { calls += 1; return ''; }, state });
  await assert.rejects(() => api.api('repos/acme/repo'), /cooldown/);
  assert.equal(calls, 0);
});

// Every REST read the relay daemon makes arrives as command(['api', <path>]).
// api() appends the path itself, so a path left in the extra args produced
// `gh api -i <path> <path>`; gh rejected it and the daemon saw only a non-zero
// exit. The path must appear exactly once.
test('an api command sends its path exactly once', async () => {
  const calls = [];
  const run = (args) => { calls.push(args); return 'HTTP/1.1 200 OK\n\n{"ok":true}'; };
  const api = createGithubApi({ env: { GITHUB_APP_INSTALLATION_TOKEN: 't' }, run,
    state: createRateLimitState({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gh-adapter-')), 's.json') }) });
  await api.command(['api', 'repos/acme/repo/pulls/565']);
  const sent = calls.at(-1);
  assert.deepEqual(sent, ['api', '-i', 'repos/acme/repo/pulls/565']);
  assert.equal(sent.filter(a => a === 'repos/acme/repo/pulls/565').length, 1);
});

test('an api command keeps its non-path arguments and still sends the path once', async () => {
  const calls = [];
  const run = (args) => { calls.push(args); return 'HTTP/1.1 200 OK\n\n{"ok":true}'; };
  const api = createGithubApi({ env: { GITHUB_APP_INSTALLATION_TOKEN: 't' }, run,
    state: createRateLimitState({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gh-adapter-')), 's.json') }) });
  await api.command(['api', '-X', 'PUT', 'repos/acme/repo/pulls/1/merge', '-f', 'merge_method=squash']);
  const sent = calls.at(-1);
  assert.equal(sent.filter(a => a === 'repos/acme/repo/pulls/1/merge').length, 1);
  assert.equal(sent.includes('-X') && sent.includes('PUT') && sent.includes('merge_method=squash'), true);
});

test('an error body that merely contains 403 does not open the circuit', async () => {
  const state = createRateLimitState({ file: `${require('os').tmpdir()}/rate-limit-${process.pid}.json` });
  const run = () => { const e = new Error('gh failed');
    e.stdout = 'x-ratelimit-remaining: 7389\nx-ratelimit-reset: 1788712824\n\n{"message":"Not Found","id":403}';
    e.stderr = ''; throw e; };
  const api = createGithubApi({ env: { GITHUB_APP_INSTALLATION_TOKEN: 't' }, run, state });
  await assert.rejects(() => api.command(['api', 'repos/o/r/pulls/1']));
  assert.equal(state.cooldown(), 0);
});

test('TTL cache deduplicates in-flight and completed repository-SHA reads', async () => {
  let now = 1000;
  const cache = createTtlCache({ ttlMs: 5000, now: () => now });
  let calls = 0;
  let release;
  const loader = () => {
    calls += 1;
    return new Promise(resolve => { release = resolve; });
  };
  const key = 'timrecursify/multica@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:check-runs';
  const first = cache.get(key, loader);
  const second = cache.get(key, loader);
  assert.equal(calls, 1);
  release('{"check_runs":[]}');
  assert.equal(await first, await second);
  assert.equal(await cache.get(key, loader), '{"check_runs":[]}');
  assert.equal(calls, 1);
  now += 5001;
  const expired = cache.get(key, loader);
  assert.equal(calls, 2);
  release('{"check_runs":[1]}');
  assert.equal(await expired, '{"check_runs":[1]}');
});

test('rate-limit cooldowns are isolated by credential scope', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gh-adapter-')), 'state.json');
  const first = createRateLimitState({ file, scope: 'installation:1' });
  const second = createRateLimitState({ file, scope: 'installation:2' });
  first.hold(Date.now() + 60000, 0, Date.now() + 60000);
  assert.ok(first.cooldown() > Date.now());
  assert.equal(second.cooldown(), 0);
});
