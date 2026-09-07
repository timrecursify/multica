const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const lane = require('./qc-lane.cjs');

test('fleet route table admits only current OpenAI desk models', () => {
  assert.equal(lane.ROUTING_CONFIG.provider, 'codex');
  assert.equal(lane.ROUTING_CONFIG.providerFamily, 'openai');
  assert.deepEqual(lane.buildLaneModelsSqlArray(), ['gpt-5.6-luna']);
  assert.deepEqual(lane.qcLaneModelsSqlArray(), ['gpt-5.6-sol', 'gpt-5.6-luna']);
  assert.deepEqual(lane.specLaneModelsSqlArray(), ['gpt-6-astra']);
  assert.equal(lane.isQcLane('gpt-5.6-luna', 'low'), true);
  assert.equal(lane.isQcLane('gpt-5.6-luna', 'high'), false);
  assert.equal(lane.isBuildLane('gpt-5.6-terra'), false);
  assert.equal(lane.isBuildLane('deepseek/v4'), false);
  assert.equal(lane.isSpecLane('claude-opus-4-6', 'low'), false);
});

test('daemon route validation fails closed on provider and model drift', () => {
  assert.deepEqual(lane.daemonRouteAdmission('codex', 'gpt-5.6-luna'), { ok: true });
  assert.equal(lane.daemonRouteAdmission('claude', 'gpt-5.6-luna').reason, 'provider_not_allowed');
  assert.equal(lane.daemonRouteAdmission('codex,openrouter', 'gpt-5.6-luna').reason, 'provider_not_allowed');
  assert.equal(lane.daemonRouteAdmission('codex', 'gpt-5.6-terra').reason, 'model_not_allowed');
});

test('build runbook reads generated instructions from the routing authority', () => {
  const runbook = fs.readFileSync(require.resolve('./RUNBOOK_BUILD_WORKER.md'), 'utf8');
  const generated = lane.workerRoutingInstructions('build');
  assert.match(runbook, /qc-lane\.cjs worker-instructions build/);
  assert.match(generated, /provider_family=openai runtime_provider=codex/);
  assert.match(generated, /lane=build model=gpt-5\.6-luna effort=low/);
  assert.doesNotMatch(runbook, /deepseek|openrouter|gpt-5\.6-terra/i);
});

test('repository preflight reads installation permission metadata', () => {
  const wrapper = fs.readFileSync(require.resolve('./multica-daemon-wrapper.sh'), 'utf8');
  assert.match(wrapper, /repos\/\$repository\/installation/);
  assert.match(wrapper, /\["contents","pull_requests","workflows"\]/);
  assert.doesNotMatch(wrapper, /curl[^\n]*--request POST|curl[^\n]*-X POST/);
});

function runWrapper(overrides = {}) {
  const beltDir = __dirname;
  const env = {
    PATH: process.env.PATH,
    BELT_TEST_MODE: '1',
    BELT_WRAPPER_TEST: '1',
    BELT_PREFLIGHT_TEST_MODE: '1',
    BELT_CPU_COUNT_CMD: 'printf 12',
    MULTICA_DAEMON_MAX_CONCURRENT_TASKS: '1',
    MULTICA_DAEMON_WORKSPACES_ROOT: path.resolve(beltDir, '../..'),
    MULTICA_DAEMON_BIN: '/bin/true',
    MULTICA_DAEMON_CWD: path.resolve(beltDir, '../..'),
    MULTICA_DAEMON_LOCK_FILE: '/dev/null',
    MULTICA_BELT_ROUTING_CONFIG: require.resolve('./qc-lane.cjs'),
    MULTICA_BELT_REPOSITORY_PERMISSION_PROBE: '/bin/true',
    MULTICA_BELT_SSH_BIN: '/bin/true',
    MULTICA_TOKEN: 'fixture-token',
    MULTICA_DAEMON_ALLOWED_PROVIDERS: 'codex',
    MULTICA_CODEX_MODEL: 'gpt-5.6-luna',
    ...overrides,
  };
  return spawnSync(require.resolve('./multica-daemon-wrapper.sh'), [], { env, encoding: 'utf8' });
}

function assertTypedBlocker(result, code) {
  assert.equal(result.status, 75, result.stderr);
  assert.match(result.stderr, new RegExp(`^PREFLIGHT_BLOCKER code=${code} .*retry_consumed=false .*disposition=queued .*resume=same_work_product`));
  assert.doesNotMatch(result.stderr, /fixture-token/);
}

test('wrapper refuses missing environment keys before daemon execution', () => {
  assertTypedBlocker(runWrapper({ MULTICA_TOKEN: '' }), 'environment_keys_missing');
});

test('wrapper keeps routing, repository, and owner outages outside retry budget', () => {
  assertTypedBlocker(runWrapper({ MULTICA_CODEX_MODEL: 'gpt-5.6-terra' }), 'routing_not_allowed');
  assertTypedBlocker(runWrapper({ MULTICA_BELT_REPOSITORY_PERMISSION_PROBE: '/bin/false' }),
    'repository_push_unavailable');
  assertTypedBlocker(runWrapper({ MULTICA_BELT_SSH_BIN: '/bin/false' }),
    'deployment_owner_unreachable');
});

test('wrapper extends the daemon executable probe after capability preflight passes', () => {
  assertTypedBlocker(runWrapper(), 'daemon_capability_unavailable');
});
