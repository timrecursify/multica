#!/usr/bin/env bash
set -Eeuo pipefail
root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
fixture="$(mktemp -d)"
trap 'rm -rf -- "$fixture"' EXIT
mkdir -p "$fixture/bin" "$fixture/state"

cat >"$fixture/bin/psql" <<'SH'
#!/usr/bin/env bash
set -Eeuo pipefail
input="$(cat)"
if [[ "$input" == *concat_ws* ]]; then
  n=0; [[ -f "$DRAIN_COUNTER" ]] && n="$(<"$DRAIN_COUNTER")"
  printf '%s\n' "$((n + 1))" > "$DRAIN_COUNTER"
  if (( n == 0 )); then echo 'leases=1 children=1 callbacks=1'; else echo 'leases=0 children=0 callbacks=0'; fi
fi
if [[ "$input" == *'admission_held = true'* ]]; then : > "$FENCE_FILE"; fi
if [[ "$input" == *'admission_held = false'* ]]; then rm -f -- "$FENCE_FILE"; fi
SH
chmod +x "$fixture/bin/psql"
export PATH="$fixture/bin:$PATH" BELT_DEPLOY_DATABASE_URL=fixture
export BELT_DEPLOY_STATE_ROOT="$fixture/state" DRAIN_COUNTER="$fixture/counter" FENCE_FILE="$fixture/fence"
export BELT_DEPLOY_DRAIN_TIMEOUT_SECONDS=3 BELT_DEPLOY_DRAIN_POLL_SECONDS=0.01
timestamp=20260907T120000Z
. "$root_dir/deployment-drain.sh"

deployment_lock_acquire
deployment_fence_close
deployment_wait_for_drain
[[ -f "$FENCE_FILE" ]] || { echo 'controller lost its durable fence' >&2; exit 1; }
[[ -f "$BELT_DEPLOY_STATE_ROOT/deployment.hold" ]] || { echo 'controller did not publish the systemd hold' >&2; exit 1; }
deployment_fence_open
[[ ! -e "$FENCE_FILE" ]] || { echo 'successful controller did not open its fence' >&2; exit 1; }
[[ ! -e "$BELT_DEPLOY_STATE_ROOT/deployment.hold" ]] || { echo 'successful controller left the systemd hold' >&2; exit 1; }
exec 8>&-

# A controller killed after fencing leaves the database hold intact for recovery.
( deployment_lock_acquire; deployment_fence_close; kill -KILL "$BASHPID" ) >/dev/null 2>&1 || true
[[ -f "$FENCE_FILE" ]] || { echo 'controller crash released the admission fence' >&2; exit 1; }
[[ -f "$BELT_DEPLOY_STATE_ROOT/deployment.hold" ]] || { echo 'controller crash released the systemd hold' >&2; exit 1; }

# flock is target-wide: the contender cannot enter until the holder exits.
( exec 8>"$BELT_DEPLOY_STATE_ROOT/deployment.lock"; flock 8; sleep 0.3 ) & holder=$!
sleep 0.05
started="$(date +%s%N)"
( exec 8>"$BELT_DEPLOY_STATE_ROOT/deployment.lock"; flock 8 )
elapsed_ms=$(( ( $(date +%s%N) - started ) / 1000000 ))
wait "$holder"
(( elapsed_ms >= 200 )) || { echo "deployment controllers did not serialize (${elapsed_ms}ms)" >&2; exit 1; }

# A nonzero snapshot times out without invoking any restart hook and retains work.
cat >"$fixture/bin/psql" <<'SH'
#!/usr/bin/env bash
input="$(cat)"
[[ "$input" == *concat_ws* ]] && echo 'leases=1 children=1 callbacks=1'
exit 0
SH
chmod +x "$fixture/bin/psql"
BELT_DEPLOY_DRAIN_TIMEOUT_SECONDS=1
if deployment_wait_for_drain >/dev/null 2>&1; then echo 'busy drain unexpectedly passed' >&2; exit 1; fi
[[ -f "$FENCE_FILE" ]] || { echo 'timed-out drain lost its work-retaining fence' >&2; exit 1; }

echo 'deployment drain tests passed: 3 assertions, 0 skipped'
