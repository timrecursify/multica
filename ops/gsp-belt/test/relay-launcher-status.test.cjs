const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const root = path.resolve(__dirname, '../../..');
const launcher = require('../relay/multica-relay-advance-launcher.cjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-test-'));
const envFile = path.join(tmp, 'operator.env');
fs.writeFileSync(envFile, 'DATABASE_URL=postgres://redacted\nRELAY_AGENT_SECRET=secret-value\nARCHIVER_AGENT_SECRET=archiver-secret\nGSP_WORKSPACE_ID=workspace\n');
const calls = [];
const fakeChild = { on(event, callback) { assert.equal(event, 'exit'); callback(0, null); } };
launcher.startDaemon({ env: { GSP_BELT_ENV_FILE: envFile }, daemonPath: '/fake/daemon.cjs', spawnImpl: (...args) => { calls.push(args); return fakeChild; } });
assert.equal(calls[0][0], '/usr/bin/node');
assert.deepEqual(calls[0][1], ['/fake/daemon.cjs']);
assert.equal(calls[0][2].env.RELAY_AGENT_SECRET, 'secret-value');
assert.throws(() => launcher.loadConfig(path.join(tmp, 'missing.env')), /does not exist/);
const bad = path.join(tmp, 'bad.env');
fs.writeFileSync(bad, 'DATABASE_URL=x\nGSP_WORKSPACE_ID=w\n');
const invalid = spawnSync(process.execPath, [path.join(root, 'ops/gsp-belt/relay/multica-relay-advance-launcher.cjs')], {
  env: { ...process.env, GSP_BELT_ENV_FILE: bad }, encoding: 'utf8'
});
assert.equal(invalid.status, 78);
assert.match(invalid.stderr, /RELAY_AGENT_SECRET is missing/);
assert(!invalid.stderr.includes('secret-value'));

const release = path.join(tmp, 'release');
fs.mkdirSync(path.join(release, 'ops/belt'), { recursive: true });
fs.writeFileSync(path.join(release, '.gsp-belt-release.json'), JSON.stringify({ commit_sha: 'a'.repeat(40) }));
const pm2 = path.join(tmp, 'pm2');
fs.writeFileSync(pm2, '#!/bin/sh\nprintf %s "$PM2_FIXTURE"\n');
fs.chmodSync(pm2, 0o755);
const fixture = JSON.stringify(['gsp-multica-bridge','gsp-multica-worker','multica-cicd-worker','multica-archiver','multica-relay-advance'].map(name => ({ name, pm2_env: { pm_exec_path: `${release}/ops/belt/${name}`, status: 'online', unstable_restarts: name === 'multica-relay-advance' ? 3 : name === 'gsp-multica-worker' ? 2 : 0, restart_time: 0, pm_err_log_path: '/var/log/relay.err', exit_code: 1, exit_signal: 'SIGTERM' } })));
const statusEnv = { ...process.env, PM2: pm2, PM2_FIXTURE: fixture };
const burstState = path.join(tmp, 'worker-burst.json');
const healthy = spawnSync('bash', [path.join(root, 'ops/gsp-belt/scripts/belt-status.sh'), '--release', release, '--baseline-relay-unstable-restarts', '3'], { env: statusEnv, encoding: 'utf8' });
assert.equal(healthy.status, 0, healthy.stderr);
const workerHealthy = spawnSync('bash', [path.join(root, 'ops/gsp-belt/scripts/belt-status.sh'), '--release', release, '--baseline-worker-unstable-restarts', '2'], { env: statusEnv, encoding: 'utf8' });
assert.equal(workerHealthy.status, 0, workerHealthy.stderr);
const workerUnhealthy = spawnSync('bash', [path.join(root, 'ops/gsp-belt/scripts/belt-status.sh'), '--release', release, '--baseline-worker-unstable-restarts', '1'], { env: statusEnv, encoding: 'utf8' });
assert.equal(workerUnhealthy.status, 1);
assert.match(workerUnhealthy.stderr, /worker unstable_restarts increased from 1 to 2/);
assert.match(workerUnhealthy.stderr, /exit_code=1.*exit_signal=SIGTERM.*log=\/var\/log\/relay.err/);
const unhealthy = spawnSync('bash', [path.join(root, 'ops/gsp-belt/scripts/belt-status.sh'), '--release', release, '--baseline-relay-unstable-restarts', '2'], { env: statusEnv, encoding: 'utf8' });
assert.equal(unhealthy.status, 1);
assert.match(unhealthy.stderr, /relay unstable_restarts increased from 2 to 3/);
assert.match(unhealthy.stderr, /exit_code=1.*exit_signal=SIGTERM.*log=\/var\/log\/relay.err/);
assert(!unhealthy.stderr.includes('secret-value'));

// Restart-burst signal is worker-specific and stateful within its bounded window.
const burstRun = (workerEnv, extra = []) => spawnSync('bash', [path.join(root, 'ops/gsp-belt/scripts/belt-status.sh'), '--release', release,
  '--worker-restart-burst-state', burstState, '--worker-restart-burst-threshold', '2', '--worker-restart-burst-window-seconds', '300', ...extra],
  { env: { ...statusEnv, PM2_FIXTURE: workerEnv }, encoding: 'utf8' });
const burstHealthy = burstRun(fixture);
assert.equal(burstHealthy.status, 0, burstHealthy.stderr);
const burstExceededFixture = JSON.stringify(JSON.parse(fixture).map(item => item.name === 'gsp-multica-worker'
  ? { ...item, pm2_env: { ...item.pm2_env, unstable_restarts: 5 } } : item));
const burstExceeded = burstRun(burstExceededFixture);
assert.equal(burstExceeded.status, 1);
assert.match(`${burstExceeded.stdout}\n${burstExceeded.stderr}`, /restart_burst app=gsp-multica-worker count=3 .*status=unhealthy/);
const missingFixture = JSON.stringify(JSON.parse(fixture).map(item => item.name === 'gsp-multica-worker'
  ? { ...item, pm2_env: { ...item.pm2_env, unstable_restarts: undefined } } : item));
const missing = burstRun(missingFixture, ['--worker-restart-burst-state', path.join(tmp, 'missing-state.json')]);
assert.equal(missing.status, 1);
assert.match(missing.stderr, /restart_burst app=gsp-multica-worker count=unknown .*diagnostic_failure/);
// Relay restarts do not contribute to the worker signal.
const relayOnly = JSON.stringify(JSON.parse(fixture).map(item => item.name === 'multica-relay-advance'
  ? { ...item, pm2_env: { ...item.pm2_env, unstable_restarts: 9 } } : item));
const relayOnlyResult = burstRun(relayOnly, ['--worker-restart-burst-state', path.join(tmp, 'relay-only-state.json')]);
assert.equal(relayOnlyResult.status, 0, relayOnlyResult.stderr);
assert.match(relayOnlyResult.stdout, /restart_burst app=gsp-multica-worker count=2 .*status=healthy/);
console.log('relay launcher/status tests: ok');
