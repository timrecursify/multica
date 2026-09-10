#!/usr/bin/env bash
set -Eeuo pipefail

root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
node "$root_dir/multica-cicd-worker.test.cjs"

# The drained fixture must be the exact string deployment_wait_for_drain compares
# against. A second hardcoded copy is what broke this file: the cicd term was
# removed from deployment_drain_snapshot and this stub kept emitting it, so every
# deploy exercise waited on a drain that could never clear. Derive it, and fail
# loudly if the comparison in deployment-drain.sh moves.
drained_snapshot="$(sed -n "s/.*\[\[ \"\$snapshot\" == '\(.*\)' \]\].*/\1/p" "$root_dir/deployment-drain.sh")"
if [[ -z "$drained_snapshot" ]]; then
  echo 'could not derive the drained snapshot literal from deployment-drain.sh' >&2
  exit 1
fi
export BELT_DEPLOY_TEST_SNAPSHOT="$drained_snapshot"

# Regression: an operator hold must suppress only the AI worker's self-healing
# path; the other pipeline services must remain in the liveness set.
guard_source="$root_dir/belt-config-guard.sh"
grep -q 'AI_HOLD_FILE=' "$guard_source"
grep -q 'gsp-multica-worker.*held by' "$guard_source"
grep -q 'readonly LIVENESS_APPS=(gsp-multica-bridge multica-cicd-worker multica-archiver gsp-multica-worker multica-relay-advance)' "$guard_source"
bash -n "$guard_source"

tmp_dir="$(mktemp -d)"
trap 'rm -rf -- "$tmp_dir"' EXIT

# Exercise restart behavior without touching the host systemd instance. The
# fake sudo preserves the production command shape while running the fake
# systemctl from this fixture's PATH.
fake_bin="$tmp_dir/bin"
fake_state="$tmp_dir/systemd"
fake_proc="$tmp_dir/proc"
mkdir -p -- "$fake_bin" "$fake_state" "$fake_proc"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -Eeuo pipefail' \
  '[[ "${1:-}" == -n ]] || exit 2' \
  'shift' \
  'exec "$@"' > "$fake_bin/sudo"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -Eeuo pipefail' \
  'command_name="${1:?}"; shift' \
  'unit="${!#}"; unit="${unit%.service}"' \
  'state_file="$BELT_DEPLOY_SYSTEMCTL_STATE/$unit.state"' \
  'IFS="|" read -r pid active substate entered < "$state_file"' \
  'case "$command_name" in' \
  '  show)' \
  '    if [[ " $* " == *" --value "* ]]; then printf "%s\\n" "$pid"' \
  '    elif [[ " $* " == *" ActiveState "* && -e "$BELT_DEPLOY_SYSTEMCTL_STATE/$unit.health-sequence" ]]; then' \
  '      IFS="|" read -r sequence_pid sequence_active sequence_substate sequence_entered < "$BELT_DEPLOY_SYSTEMCTL_STATE/$unit.health-sequence"' \
  '      tail -n +2 "$BELT_DEPLOY_SYSTEMCTL_STATE/$unit.health-sequence" > "$BELT_DEPLOY_SYSTEMCTL_STATE/$unit.health-sequence.next"' \
  '      mv -- "$BELT_DEPLOY_SYSTEMCTL_STATE/$unit.health-sequence.next" "$BELT_DEPLOY_SYSTEMCTL_STATE/$unit.health-sequence"' \
  '      printf "MainPID=%s\\nActiveState=%s\\nSubState=%s\\n" "$sequence_pid" "$sequence_active" "$sequence_substate"' \
  '    elif [[ " $* " == *" ActiveState "* && -e "$BELT_DEPLOY_SYSTEMCTL_STATE/$unit.health-fail" ]]; then' \
  '      printf "MainPID=%s\\nActiveState=failed\\nSubState=%s\\n" "$pid" "$substate"' \
  '    else printf "MainPID=%s\\nActiveState=%s\\nSubState=%s\\nActiveEnterTimestamp=%s\\n" "$pid" "$active" "$substate" "$entered"; fi ;;' \
  '  is-active) [[ "$active" == active ]] ;;' \
  '  restart)' \
  '    if [[ -e "$BELT_DEPLOY_SYSTEMCTL_STATE/$unit.fail" ]]; then' \
  '      printf "0|failed|failed|n/a\\n" > "$state_file"; exit 0' \
  '    fi' \
  '    new_pid=$((pid + 100))' \
  '    case "$unit" in' \
  '      gsp-multica-bridge) executable=/usr/bin/node; entrypoint="$BELT_DEPLOY_RUNTIME_ROOT/gsp-multica-bridge/multica-bridge.cjs" ;;' \
  '      multica-relay-advance) executable=/usr/bin/node; entrypoint="$BELT_DEPLOY_RUNTIME_ROOT/multica-relay-advance/app/parity/multica-relay-advance-launcher.cjs" ;;' \
  '      multica-cicd-worker) executable=/usr/bin/node; entrypoint="$BELT_DEPLOY_RUNTIME_ROOT/multica-cicd-worker/multica-cicd-worker.cjs" ;;' \
  '      multica-archiver) executable=/usr/bin/node; entrypoint="$BELT_DEPLOY_RUNTIME_ROOT/multica-archiver/multica-archiver.cjs" ;;' \
  '      gsp-multica-worker|gsp-multica-worker-ppp) executable=/bin/bash; entrypoint="$BELT_DEPLOY_RUNTIME_ROOT/gsp-multica-worker/multica-daemon-wrapper.sh" ;;' \
  '    esac' \
  '    mkdir -p -- "$BELT_DEPLOY_PROC_ROOT/$new_pid"' \
  '    printf "%s\\0%s\\0" "$executable" "$entrypoint" > "$BELT_DEPLOY_PROC_ROOT/$new_pid/cmdline"' \
  '    if [[ -e "$BELT_DEPLOY_SYSTEMCTL_STATE/$unit.wrong-entrypoint" ]]; then printf "%s\\0%s\\0" "$executable" /tmp/wrong-entrypoint.cjs > "$BELT_DEPLOY_PROC_ROOT/$new_pid/cmdline"; fi' \
  '    printf "%s|active|running|Mon 2026-09-07 14:00:00 UTC\\n" "$new_pid" > "$state_file"' \
  '    printf "%s|%s|%s\\n" "$unit" "$pid" "$new_pid" >> "$BELT_DEPLOY_SYSTEMCTL_STATE/restarts.log" ;;' \
  '  *) exit 2 ;;' \
  'esac' > "$fake_bin/systemctl"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'printf "fake journal: unit=%s crashed after restart\\n" "${2:-unknown}"' > "$fake_bin/journalctl"
chmod +x -- "$fake_bin/sudo" "$fake_bin/systemctl" "$fake_bin/journalctl"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -Eeuo pipefail' \
  'input="$(cat)"' \
  'if [[ "$input" == *"concat_ws"* ]]; then printf "%s\n" "${BELT_DEPLOY_TEST_SNAPSHOT:?}"; fi' \
  'kind=other' \
  '[[ "$input" == *"admission_held = true"* ]] && kind=close' \
  '[[ "$input" == *"admission_held = false"* ]] && kind=open' \
  'printf "%s|%s|%s\n" "$$" "$kind" "$*" >> "${BELT_DEPLOY_TEST_PSQL_LOG:?}"' > "$fake_bin/psql"
chmod +x -- "$fake_bin/psql"
export PATH="$fake_bin:$PATH"
export BELT_DEPLOY_SYSTEMCTL_STATE="$fake_state"
export BELT_DEPLOY_PROC_ROOT="$fake_proc"
export BELT_DEPLOY_STATE_ROOT="$tmp_dir/deploy-state"
export BELT_DEPLOY_DATABASE_URL="postgres://fixture"
export BELT_DEPLOY_DRAIN_TIMEOUT_SECONDS=2
export BELT_DEPLOY_HEALTH_SETTLE_SECONDS=1
export BELT_DEPLOY_TEST_PSQL_LOG="$tmp_dir/psql.log"
: > "$BELT_DEPLOY_TEST_PSQL_LOG"
receipt_root="$tmp_dir/receipts"
source_sha="$(git -C "$root_dir/../.." rev-parse HEAD)"
export MULTICA_RECEIPT_ROOT="$receipt_root"
fake_pid=1000
for unit in multica-relay-advance gsp-multica-worker gsp-multica-worker-ppp \
  multica-cicd-worker multica-archiver gsp-multica-bridge; do
  printf '%s|active|running|Mon 2026-09-07 13:30:00 UTC\n' "$fake_pid" > "$fake_state/$unit.state"
  fake_pid=$((fake_pid + 1000))
done

# Expectations come from the canonical manifest, never a second copy of it.
runtime_root="$tmp_dir"
export BELT_DEPLOY_GLOBAL_BIN_ROOT="$tmp_dir/usr-local-bin"
export BELT_DEPLOY_SKIP_OWNERSHIP=1
. "$root_dir/belt-manifest.sh"
[[ "${#sources[@]}" -eq "${#targets[@]}" ]] || { echo 'manifest arrays are not index-aligned' >&2; exit 1; }
"$root_dir/manifest-require-graph.test.sh"
BELT_DEPLOY_GLOBAL_BIN_ROOT="$tmp_dir/usr-local-bin" "$root_dir/manifest-closure.test.sh"

# The wrapper sources helper scripts by absolute path, so a runtime missing one
# cannot start -- belt-concurrency.sh was absent from a live worker for exactly
# this reason. Anything the wrapper sources must therefore be a deployed target.
while read -r sourced; do
  [[ -n "$sourced" ]] || continue
  printf '%s\n' "${targets[@]}" | grep -q "/gsp-multica-worker/$sourced\$" || {
    echo "wrapper sources $sourced but the manifest never deploys it" >&2
    exit 1
  }
done < <(grep -o '/[a-z-]*\.sh"$' "$root_dir/multica-daemon-wrapper.sh" | tr -d '/"')

# Same failure, one directory over: a file under parity/ reaches its siblings
# with require('../name.cjs'), which resolves outside parity/. Shipping such a
# file into parity/ leaves the require unresolved and the daemon dies at start.
# Resolve each one against the deployed layout instead of trusting the path.
for parity_file in "$root_dir"/parity/*.cjs; do
  [[ -e "$parity_file" ]] || continue
  # Test files stay in the repository, so their requires say nothing about the
  # deployed layout.
  case "$parity_file" in *.test.cjs) continue ;; esac
  while read -r required; do
    [[ -n "$required" ]] || continue
    printf '%s\n' "${targets[@]}" | grep -q "/app/$required\$" || {
      echo "parity/$(basename "$parity_file") requires ../$required, which the manifest does not deploy to app/" >&2
      exit 1
    }
  done < <(grep -o "require('\.\./[a-z-]*\.cjs')" "$parity_file" | sed "s|require('\.\./||; s|')||")
done

# These targets are absent beforehand, so a rollback must delete them outright
# rather than restore a backup.
is_new_target() {
  case "${1##*/}" in
    guardrails.cjs|human-review-routing.cjs|astra-adjudication.cjs|parked-diagnosis.cjs|parked-entry-audit.cjs|relay-dead-rows.cjs|relay-completion-admission.cjs|RUNBOOK_ASTRA_ADJUDICATOR.md) return 0 ;;
    *) return 1 ;;
  esac
}

for index in "${!targets[@]}"; do
  mkdir -p -- "$(dirname -- "${targets[$index]}")"
  is_new_target "${targets[$index]}" && continue
  cp -- "${sources[$index]}" "${targets[$index]}"
done

bridge_dir="$tmp_dir/gsp-multica-bridge"
relay_dir="$tmp_dir/multica-relay-advance/app"
worker_dir="$tmp_dir/gsp-multica-worker"
cicd_dir="$tmp_dir/multica-cicd-worker"
doctrine_dir="$tmp_dir/multica-doctrine"

dry_log="$tmp_dir/dry-run.log"
BELT_DEPLOY_RUNTIME_ROOT="$tmp_dir" "$root_dir/deploy.sh" --dry-run >"$dry_log"
grep -q "Would copy .*/parked-diagnosis.cjs to $bridge_dir/parked-diagnosis.cjs" "$dry_log"
grep -q "Would copy .*/parked-diagnosis.cjs to $relay_dir/parked-diagnosis.cjs" "$dry_log"
grep -q "Would copy .*/astra-adjudication.cjs to $bridge_dir/astra-adjudication.cjs" "$dry_log"
grep -q "Would copy .*/astra-adjudication.cjs to $relay_dir/astra-adjudication.cjs" "$dry_log"
grep -q "Would copy .*/parity/relay-dead-rows.cjs to .*/parity/relay-dead-rows.cjs" "$dry_log"
grep -q "Would copy .*/multica-bundle.py to $doctrine_dir/multica-bundle.py" "$dry_log"
grep -q "Would copy .*/RUNBOOK_SPEC_WORKER.md to $doctrine_dir/RUNBOOK_SPEC_WORKER.md" "$dry_log"
grep -q "Would copy .*/RUNBOOK_ASTRA_ADJUDICATOR.md to $doctrine_dir/RUNBOOK_ASTRA_ADJUDICATOR.md" "$dry_log"
# transition-policy.cjs ships to three service directories from one source row.
[[ "$(grep -c 'Would copy .*/transition-policy.cjs' "$dry_log")" -eq 3 ]]
grep -q '^Would restart gsp-multica-bridge$' "$dry_log"
grep -q '^Would restart multica-relay-advance$' "$dry_log"
grep -q '^Would restart gsp-multica-worker$' "$dry_log"
grep -q '^Would restart gsp-multica-worker-ppp$' "$dry_log"
[[ "$(grep -c '^Would restart ' "$dry_log")" -eq 4 ]]

# An unscoped apply rewrites every managed target, so it must be requested by name.
if BELT_DEPLOY_RUNTIME_ROOT="$tmp_dir" "$root_dir/deploy.sh" --apply >"$tmp_dir/unscoped.log" 2>&1; then
  echo 'expected refusal of an unscoped --apply' >&2
  exit 1
fi
grep -q 'Refusing an unscoped --apply' "$tmp_dir/unscoped.log"

# A busy drain aborts before backup/copy/restart. The active task row is never
# mutated by the controller, so it remains available to finish and publish.
printf '\nstale-runtime\n' >> "$bridge_dir/multica-bridge.cjs"
restart_lines() { if [[ -f "$fake_state/restarts.log" ]]; then wc -l < "$fake_state/restarts.log"; else printf '0\n'; fi; }
restarts_before="$(restart_lines)"
psql_line_before="$(wc -l < "$BELT_DEPLOY_TEST_PSQL_LOG" 2>/dev/null || printf 0)"
if BELT_DEPLOY_TEST_SNAPSHOT="${drained_snapshot//=0/=1}" \
   BELT_DEPLOY_DRAIN_TIMEOUT_SECONDS=1 BELT_DEPLOY_RUNTIME_ROOT="$tmp_dir" \
   "$root_dir/deploy.sh" --apply --only multica-bridge.cjs >"$tmp_dir/drain-timeout.log" 2>&1; then
  echo 'expected busy drain to abort deployment' >&2
  exit 1
fi
grep -q 'deployment aborted without restart' "$tmp_dir/drain-timeout.log"
tail -n "+$((psql_line_before + 1))" "$BELT_DEPLOY_TEST_PSQL_LOG" > "$tmp_dir/drain-timeout-psql.log"
grep -q '|close|' "$tmp_dir/drain-timeout-psql.log"
if grep -q '|open|' "$tmp_dir/drain-timeout-psql.log"; then
  echo 'genuine drain timeout unexpectedly opened its fence' >&2; exit 1
fi
[[ "$restarts_before" == "$(restart_lines)" ]]
grep -q 'stale-runtime' "$bridge_dir/multica-bridge.cjs"
cp -- "$root_dir/multica-bridge.cjs" "$bridge_dir/multica-bridge.cjs"

# Validation can abort after fencing but before the first drain snapshot. The
# EXIT/ERR cleanup must reopen that fence; no timeout is inferred.
psql_line_before="$(wc -l < "$BELT_DEPLOY_TEST_PSQL_LOG")"
if env -u BELT_DEPLOY_DRAIN_TIMEOUT_SECONDS BELT_DEPLOY_RUNTIME_ROOT="$tmp_dir" \
  "$root_dir/deploy.sh" --apply --only multica-bridge.cjs >"$tmp_dir/drain-unset.log" 2>&1; then
  echo 'expected unset drain timeout to abort deployment' >&2; exit 1
fi
tail -n "+$((psql_line_before + 1))" "$BELT_DEPLOY_TEST_PSQL_LOG" > "$tmp_dir/drain-unset-psql.log"
grep -q 'must be set to a positive integer' "$tmp_dir/drain-unset.log"
grep -q '|close|' "$tmp_dir/drain-unset-psql.log"
grep -q '|open|' "$tmp_dir/drain-unset-psql.log"

# INT and TERM use the same idempotent cleanup while blocked in a real drain.
for signal in INT TERM; do
  psql_line_before="$(wc -l < "$BELT_DEPLOY_TEST_PSQL_LOG")"
  timeout --foreground --signal="$signal" --kill-after=2 1.2 env \
    BELT_DEPLOY_TEST_SNAPSHOT="${drained_snapshot//=0/=1}" \
    BELT_DEPLOY_DRAIN_TIMEOUT_SECONDS=30 BELT_DEPLOY_DRAIN_POLL_SECONDS=1 \
    BELT_DEPLOY_RUNTIME_ROOT="$tmp_dir" \
    "$root_dir/deploy.sh" --apply --only multica-bridge.cjs >"$tmp_dir/signal-$signal.log" 2>&1 || true
  tail -n "+$((psql_line_before + 1))" "$BELT_DEPLOY_TEST_PSQL_LOG" > "$tmp_dir/signal-$signal-psql.log"
  grep -q '|close|' "$tmp_dir/signal-$signal-psql.log"
  [[ "$(grep -c '|open|' "$tmp_dir/signal-$signal-psql.log")" -eq 1 ]] || {
    echo "$signal cleanup did not open its fence exactly once" >&2; exit 1;
  }
done

# The complementary half of the busy case. Without it a fixture that can never
# drain aborts every later exercise silently instead of failing on its own line.
printf '\nstale-runtime-drained\n' >> "$bridge_dir/multica-bridge.cjs"
restarts_before="$(restart_lines)"
BELT_DEPLOY_DRAIN_TIMEOUT_SECONDS=1 BELT_DEPLOY_RUNTIME_ROOT="$tmp_dir" \
  "$root_dir/deploy.sh" --apply --only multica-bridge.cjs >"$tmp_dir/drain-clear.log" 2>&1
if grep -q 'deployment aborted without restart' "$tmp_dir/drain-clear.log"; then
  echo 'expected a drained deploy to proceed' >&2
  exit 1
fi
if [[ "$restarts_before" == "$(restart_lines)" ]]; then
  echo 'expected a drained deploy to restart the unit' >&2
  exit 1
fi
if grep -q 'stale-runtime-drained' "$bridge_dir/multica-bridge.cjs"; then
  echo 'expected a drained deploy to replace the runtime file' >&2
  exit 1
fi

# A partial rollout can leave the wrapper absent. It is a named parity target and
# must be recreated by a selective deployment.
rm -f -- "$worker_dir/multica-daemon-wrapper.sh"
BELT_DEPLOY_RUNTIME_ROOT="$tmp_dir" "$root_dir/deploy.sh" --apply --only multica-daemon-wrapper.sh >"$tmp_dir/missing-wrapper.log"
cmp -s -- "$root_dir/multica-daemon-wrapper.sh" "$worker_dir/multica-daemon-wrapper.sh"
grep -q "Copied .*/multica-daemon-wrapper.sh to $worker_dir/multica-daemon-wrapper.sh" "$tmp_dir/missing-wrapper.log"
grep -q '^Restarted gsp-multica-worker: 2000 -> 2100 ' "$tmp_dir/missing-wrapper.log"
grep -q '^Restarted gsp-multica-worker-ppp: 3000 -> 3100 ' "$tmp_dir/missing-wrapper.log"

# Remove a dependency from a disposable manifest copy. Validation must fail
# before copy, proving the deploy cannot restart with an incomplete runtime.
manifest_dir="$tmp_dir/manifest"
cp -a -- "$root_dir/." "$manifest_dir/"
sed -i '/parked-diagnosis\.cjs/d' "$manifest_dir/belt-manifest.sh"
if BELT_DEPLOY_RUNTIME_ROOT="$tmp_dir" "$manifest_dir/deploy.sh" --apply --all >"$tmp_dir/missing-dependency.log" 2>&1; then
  echo 'expected missing runtime dependency rejection' >&2
  exit 1
fi
grep -q 'Missing manifest runtime dependency:' "$tmp_dir/missing-dependency.log"
if grep -q 'Would\|Copied\|Backed up' "$tmp_dir/missing-dependency.log"; then
  echo 'manifest validation ran after deployment work' >&2
  exit 1
fi

# An injected mid-deploy failure must restore every original and delete every
# target the deploy created.
if BELT_DEPLOY_RUNTIME_ROOT="$tmp_dir" BELT_DEPLOY_FAIL_INDEX=2 \
   "$root_dir/deploy.sh" --apply --all >"$tmp_dir/fail.log" 2>&1; then
  echo 'expected injected deployment failure' >&2
  exit 1
fi
for index in "${!targets[@]}"; do
  target="${targets[$index]}"
  if is_new_target "$target"; then
    [[ ! -e "$target" ]] || { echo "new target survived rollback: $target" >&2; exit 1; }
  else
    cmp -s -- "${sources[$index]}" "$target" || { echo "target not restored: $target" >&2; exit 1; }
  fi
done

apply_log="$tmp_dir/apply.log"
BELT_DEPLOY_RUNTIME_ROOT="$tmp_dir" "$root_dir/deploy.sh" --apply --all >"$apply_log"
BELT_DEPLOY_RUNTIME_ROOT="$tmp_dir" "$root_dir/verify.sh" "$(git -C "$root_dir/../.." rev-parse HEAD)" >"$tmp_dir/verify.log"
grep -q "Match: $cicd_dir/multica-cicd-worker.cjs" "$tmp_dir/verify.log"
[[ "$(stat -c '%a:%g' "$doctrine_dir/multica-bundle.py")" == "750:$(stat -c '%g' "$doctrine_dir")" ]]
[[ "$(stat -c '%a:%g' "$doctrine_dir/RUNBOOK_SPEC_WORKER.md")" == "640:$(stat -c '%g' "$doctrine_dir")" ]]
[[ "$(stat -c '%a:%g' "$doctrine_dir/RUNBOOK_ASTRA_ADJUDICATOR.md")" == "640:$(stat -c '%g' "$doctrine_dir")" ]]
receipt="$(sed -n 's/^Rollback receipt: .* --rollback \([0-9T]*Z\)$/\1/p' "$apply_log")"
[[ "$receipt" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || { echo 'missing rollback receipt' >&2; exit 1; }
BELT_DEPLOY_RUNTIME_ROOT="$tmp_dir" "$root_dir/deploy.sh" --rollback "$receipt" >/dev/null
for suffix in guardrails.cjs astra-adjudication.cjs parked-diagnosis.cjs parked-entry-audit.cjs relay-completion-admission.cjs; do
  [[ ! -e "$bridge_dir/$suffix" ]] || { echo "rollback did not remove $suffix" >&2; exit 1; }
  [[ ! -e "$relay_dir/$suffix" ]] || { echo "rollback did not remove relay copy of $suffix" >&2; exit 1; }
done
[[ ! -e "$doctrine_dir/RUNBOOK_ASTRA_ADJUDICATOR.md" ]] || { echo 'rollback did not remove Astra adjudicator runbook' >&2; exit 1; }
[[ ! -e "$relay_dir/parity/relay-dead-rows.cjs" ]] || { echo 'rollback did not remove relay dead rows target' >&2; exit 1; }

# A selective deploy touches only what it names.
before_bridge="$(sha256sum "$bridge_dir/multica-bridge.cjs")"
printf '\nstale-runtime\n' >> "$cicd_dir/multica-cicd-worker.cjs"
BELT_DEPLOY_RUNTIME_ROOT="$tmp_dir" "$root_dir/deploy.sh" --apply --only multica-cicd-worker >"$tmp_dir/selective.log"
cmp -s -- "$root_dir/multica-cicd-worker.cjs" "$cicd_dir/multica-cicd-worker.cjs"
[[ "$before_bridge" == "$(sha256sum "$bridge_dir/multica-bridge.cjs")" ]]
grep -q 'Backed up .*/multica-cicd-worker.cjs' "$tmp_dir/selective.log"
if grep -q 'relay-dead-rows.cjs' "$tmp_dir/selective.log"; then
  echo '--only multica-cicd-worker selected relay-dead-rows.cjs' >&2
  exit 1
fi
[[ "$(grep -c '^Backed up ' "$tmp_dir/selective.log")" -eq 1 ]]
selective_receipt="$(sed -n 's/^Rollback receipt: .* --rollback \([0-9T]*Z\) --only multica-cicd-worker$/\1/p' "$tmp_dir/selective.log")"
[[ "$selective_receipt" =~ ^[0-9]{8}T[0-9]{6}Z$ ]]
activation_receipt="$receipt_root/timrecursify/multica/gsp-belt/$source_sha.json"
node -e 'const r=require(process.argv[1]),s=process.argv[2],a=Date.parse(r.activation?.activated_at),h=Date.parse(r.health?.checked_at);if(r.schema_version!==1||r.repository!=="timrecursify/multica"||r.target!=="gsp-belt"||r.deployment_owner!=="ops/belt/deploy.sh"||r.source_sha!==s||r.activation?.status!=="activated"||r.activation?.process_sha!==s||r.activation?.release!==`git:timrecursify/multica@${s}`||!Number.isFinite(a)||!Number.isFinite(h)||h<a||r.health?.status!=="ok"||r.health?.probe!=="systemd-active-mainpid-runtime-parity-v1"||r.stale_fence_alarm?.status!=="not_required")process.exit(1)' \
  "$activation_receipt" "$source_sha"
grep -q "^Receipt: $activation_receipt$" "$tmp_dir/selective.log"
BELT_DEPLOY_RUNTIME_ROOT="$tmp_dir" "$root_dir/deploy.sh" --rollback "$selective_receipt" --only multica-cicd-worker >/dev/null

# A no-op apply and an explicit copy-only apply must restart nothing.
noop_receipt_root="$tmp_dir/noop-receipts"
MULTICA_RECEIPT_ROOT="$noop_receipt_root" BELT_DEPLOY_RUNTIME_ROOT="$tmp_dir" \
  "$root_dir/deploy.sh" --apply --only multica-bridge.cjs > "$tmp_dir/noop.log"
grep -q '^No processes were restarted.$' "$tmp_dir/noop.log"
[[ ! -e "$noop_receipt_root/timrecursify/multica/gsp-belt/$source_sha.json" ]]
restart_count="$(wc -l < "$fake_state/restarts.log")"
printf '\nstale-runtime\n' >> "$tmp_dir/multica-archiver/multica-archiver.cjs"
no_restart_receipt_root="$tmp_dir/no-restart-receipts"
MULTICA_RECEIPT_ROOT="$no_restart_receipt_root" BELT_DEPLOY_RUNTIME_ROOT="$tmp_dir" \
  "$root_dir/deploy.sh" --apply --no-restart --only multica-archiver > "$tmp_dir/no-restart.log"
[[ "$restart_count" -eq "$(wc -l < "$fake_state/restarts.log")" ]]
grep -q '^Restarts disabled (--no-restart).$' "$tmp_dir/no-restart.log"
[[ ! -e "$no_restart_receipt_root/timrecursify/multica/gsp-belt/$source_sha.json" ]]

# A missing nested directory below an existing canonical service root is
# created by selective deployment.
rm -rf -- "$relay_dir/parity"
BELT_DEPLOY_RUNTIME_ROOT="$tmp_dir" "$root_dir/deploy.sh" --apply --only multica-relay-advance-daemon >"$tmp_dir/parity-create.log"
cmp -s -- "$root_dir/parity/multica-relay-advance-daemon.cjs" "$relay_dir/parity/multica-relay-advance-daemon.cjs"
grep -q "Created target directory $relay_dir/parity" "$tmp_dir/parity-create.log"
grep -q 'Backed up absence of new target' "$tmp_dir/parity-create.log"
grep -q '^Restarted multica-relay-advance: ' "$tmp_dir/parity-create.log"

# A selected wrapper is repaired even when runtime drifted; omitting it keeps
# the fail-closed parity guard.
printf '\nwrapper-drift\n' >> "$worker_dir/multica-daemon-wrapper.sh"
BELT_DEPLOY_RUNTIME_ROOT="$tmp_dir" "$root_dir/deploy.sh" --apply --all >"$tmp_dir/wrapper-drift.log"
cmp -s -- "$root_dir/multica-daemon-wrapper.sh" "$worker_dir/multica-daemon-wrapper.sh"
wrapper_receipt="$(sed -n 's/^Rollback receipt: .* --rollback \([0-9T]*Z\)$/\1/p' "$tmp_dir/wrapper-drift.log")"
[[ "$wrapper_receipt" =~ ^[0-9]{8}T[0-9]{6}Z$ ]]
BELT_DEPLOY_RUNTIME_ROOT="$tmp_dir" "$root_dir/deploy.sh" --rollback "$wrapper_receipt" >/dev/null
printf '\nwrapper-drift-again\n' >> "$worker_dir/multica-daemon-wrapper.sh"
if BELT_DEPLOY_RUNTIME_ROOT="$tmp_dir" "$root_dir/deploy.sh" --apply --only multica-bridge.cjs >"$tmp_dir/wrapper-selective.log" 2>&1; then
  echo 'expected drifted unselected wrapper rejection' >&2
  exit 1
fi
grep -q 'Wrapper preflight: source/runtime parity mismatch (wrapper not selected)' "$tmp_dir/wrapper-selective.log"

# A successful restart is not enough: a failed named health probe must refuse
# the receipt even when the post-copy runtime still matches the source.
cp -- "$root_dir/multica-daemon-wrapper.sh" "$worker_dir/multica-daemon-wrapper.sh"
printf '\nstale-runtime\n' >> "$cicd_dir/multica-cicd-worker.cjs"
: > "$fake_state/multica-cicd-worker.health-fail"
health_fail_receipt_root="$tmp_dir/health-fail-receipts"
if MULTICA_RECEIPT_ROOT="$health_fail_receipt_root" BELT_DEPLOY_RUNTIME_ROOT="$tmp_dir" \
   "$root_dir/deploy.sh" --apply --only multica-cicd-worker > "$tmp_dir/health-fail.log" 2>&1; then
  echo 'expected failed health probe to fail deployment' >&2
  exit 1
fi
grep -q '^Health probe systemd-active-mainpid-runtime-parity-v1 failed: multica-cicd-worker ' "$tmp_dir/health-fail.log"
[[ ! -e "$health_fail_receipt_root/timrecursify/multica/gsp-belt/$source_sha.json" ]]

# A restart can briefly report auto-restart/activating before systemd exposes
# the replacement process. The health probe must settle and then validate the
# PID it actually observes.
rm -f -- "$fake_state/multica-cicd-worker.health-fail"
printf '\nstale-runtime\n' >> "$cicd_dir/multica-cicd-worker.cjs"
settle_pid=$(( $(cut -d'|' -f1 "$fake_state/multica-cicd-worker.state") + 100 ))
printf '0|activating|auto-restart|\n0|activating|auto-restart|\n%s|active|running|\n' "$settle_pid" \
  > "$fake_state/multica-cicd-worker.health-sequence"
BELT_DEPLOY_RUNTIME_ROOT="$tmp_dir" "$root_dir/deploy.sh" --apply --only multica-cicd-worker > "$tmp_dir/health-settle-pass.log"
grep -q "^Health probe systemd-active-mainpid-runtime-parity-v1 passed: multica-cicd-worker pid=$settle_pid$" "$tmp_dir/health-settle-pass.log"

# A unit stuck in auto-restart beyond the bounded window must still fail.
printf '\nstale-runtime\n' >> "$cicd_dir/multica-cicd-worker.cjs"
for _ in {1..40}; do printf '0|activating|auto-restart|\n'; done > "$fake_state/multica-cicd-worker.health-sequence"
if BELT_DEPLOY_RUNTIME_ROOT="$tmp_dir" "$root_dir/deploy.sh" --apply --only multica-cicd-worker > "$tmp_dir/health-settle-timeout.log" 2>&1; then
  echo 'expected a unit stuck in auto-restart to fail health probe' >&2
  exit 1
fi
grep -q 'settle_window_seconds=1' "$tmp_dir/health-settle-timeout.log"

# Reaching active/running is not sufficient when the observed process is not
# the deployed entrypoint.
printf '\nstale-runtime\n' >> "$cicd_dir/multica-cicd-worker.cjs"
entrypoint_pid=$(( $(cut -d'|' -f1 "$fake_state/multica-cicd-worker.state") + 100 ))
printf '%s|active|running|\n' "$entrypoint_pid" > "$fake_state/multica-cicd-worker.health-sequence"
: > "$fake_state/multica-cicd-worker.wrong-entrypoint"
if BELT_DEPLOY_RUNTIME_ROOT="$tmp_dir" "$root_dir/deploy.sh" --apply --only multica-cicd-worker > "$tmp_dir/health-entrypoint-fail.log" 2>&1; then
  echo 'expected wrong deployed entrypoint to fail health probe' >&2
  exit 1
fi
grep -q 'did not report the deployed entrypoint' "$tmp_dir/health-entrypoint-fail.log"

# A restart command that exits zero can still leave the service failed. The
# deploy must reject that state and include journal evidence.
cp -- "$root_dir/multica-daemon-wrapper.sh" "$worker_dir/multica-daemon-wrapper.sh"
printf '\nstale-runtime\n' >> "$tmp_dir/multica-archiver/multica-archiver.cjs"
: > "$fake_state/multica-archiver.fail"
if BELT_DEPLOY_RUNTIME_ROOT="$tmp_dir" "$root_dir/deploy.sh" --apply --only multica-archiver > "$tmp_dir/restart-fail.log" 2>&1; then
  echo 'expected failed service restart to fail deployment' >&2
  exit 1
fi
grep -q '^Restart verification failed: multica-archiver ' "$tmp_dir/restart-fail.log"
grep -q 'fake journal: unit=multica-archiver crashed after restart' "$tmp_dir/restart-fail.log"
if grep -q '^Receipt:' "$tmp_dir/restart-fail.log"; then
  echo 'failed restart wrote a success receipt' >&2
  exit 1
fi

# Keep the absent-service-root check last because it deliberately removes the
# relay fixture that later full-manifest tests require.
cp -- "$root_dir/multica-daemon-wrapper.sh" "$worker_dir/multica-daemon-wrapper.sh"
rm -rf -- "$tmp_dir/multica-relay-advance"
if BELT_DEPLOY_RUNTIME_ROOT="$tmp_dir" "$root_dir/deploy.sh" --apply --only multica-relay-advance-daemon >"$tmp_dir/missing-service.log" 2>&1; then
  echo 'expected missing canonical service root rejection' >&2
  exit 1
fi
grep -q 'Missing runtime file:' "$tmp_dir/missing-service.log"
echo 'deploy rollback test passed'
