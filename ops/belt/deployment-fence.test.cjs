const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');

const belt = __dirname;
const drain = readFileSync(join(belt, 'deployment-drain.sh'), 'utf8');
const deploy = readFileSync(join(belt, 'deploy.sh'), 'utf8');
const guard = readFileSync(join(belt, 'belt-config-guard.sh'), 'utf8');
const lock = readFileSync(join(belt, 'deployment-lock.sql'), 'utf8');

test('a dead controller hold is taken over and the takeover is recorded', () => {
  execFileSync('bash', ['-c', `
    set -Eeuo pipefail
    fixture=$(mktemp -d)
    trap 'rm -rf -- "$fixture"' EXIT
    root_dir=$1
    timestamp=20260908T100000Z
    BELT_DEPLOY_STATE_ROOT="$fixture/state"
    BELT_DEPLOY_INVOCATION_ID=new-controller
    deployment_fence_closed=0
    mkdir -p "$BELT_DEPLOY_STATE_ROOT"
    source "$root_dir/deployment-drain.sh"
    deployment_process_identity() { [[ "$1" == "$$" ]] && printf '100|new-boot\\n' || return 1; }
    deployment_fence_alarm() { printf 'alarm\\n' >> "$fixture/events"; }
    deployment_psql() {
      local input
      input=$(cat)
      if [[ " $* " == *' -At '* && "$input" == *'SELECT admission_held'* ]]; then
        printf '1|old-controller|999999|42|old-boot\\n'
      else
        printf '%s\\n' "$* $input" >> "$fixture/sql"
      fi
    }
    deployment_fence_close >/dev/null
    grep -q '^alarm$' "$fixture/events"
    grep -q "takeover_invocation=old-controller" "$fixture/sql"
    grep -q "taking_over=true" "$fixture/sql"
  `, '_', belt], { stdio: 'pipe' });
  assert.match(lock, /takeover_of_invocation_id text/);
  assert.match(lock, /takeover_at timestamptz/);
});

test('controller liveness rejects PID reuse by binding boot id and process start ticks', () => {
  assert.match(drain, /controller_start_ticks/);
  assert.match(drain, /controller_boot_id/);
  assert.doesNotMatch(drain, /kill -0/);
  assert.match(drain, /identity" == "\$expected_start\|\$expected_boot/);
});

test('an unset drain timeout is reopened while a genuine timeout stays closed', () => {
  assert.match(deploy, /deployment_fence_closed == 1 && deployment_drain_timed_out == 0/);
  assert.match(drain, /deployment_drain_timed_out=1/);
});

test('EXIT, INT, and TERM traps drive idempotent fence cleanup', () => {
  assert.match(deploy, /trap 'restore_on_failure \$\?' ERR EXIT/);
  assert.match(deploy, /trap 'restore_on_failure 130' INT/);
  assert.match(deploy, /trap 'restore_on_failure 143' TERM/);
  assert.match(deploy, /deployment_cleanup_running/);
});

test('the existing belt sentinel raises a P0 for a dead fence controller', () => {
  assert.match(guard, /guard_deployment_fence/);
  assert.match(guard, /admission fence held by dead controller/);
  assert.match(guard, /file_p0 "belt config drift the guard could not repair"/);
});

test('scratch deploy integration covers timeout-unset, timeout, INT, and TERM', () => {
  execFileSync('bash', [join(belt, 'deploy.test.sh')], {
    cwd: join(belt, '..', '..'),
    env: { ...process.env, FORCE_COLOR: '0' },
    stdio: 'pipe',
    timeout: 120000,
  });
});
