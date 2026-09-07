#!/usr/bin/env bash
set -Eeuo pipefail

root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
node "$root_dir/multica-cicd-worker.test.cjs"

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
mkdir -p -- "$fake_bin" "$fake_state"
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
  '    else printf "MainPID=%s\\nSubState=%s\\nActiveEnterTimestamp=%s\\n" "$pid" "$substate" "$entered"; fi ;;' \
  '  is-active) [[ "$active" == active ]] ;;' \
  '  restart)' \
  '    if [[ -e "$BELT_DEPLOY_SYSTEMCTL_STATE/$unit.fail" ]]; then' \
  '      printf "0|failed|failed|n/a\\n" > "$state_file"; exit 0' \
  '    fi' \
  '    new_pid=$((pid + 100))' \
  '    printf "%s|active|running|Mon 2026-09-07 14:00:00 UTC\\n" "$new_pid" > "$state_file"' \
  '    printf "%s|%s|%s\\n" "$unit" "$pid" "$new_pid" >> "$BELT_DEPLOY_SYSTEMCTL_STATE/restarts.log" ;;' \
  '  *) exit 2 ;;' \
  'esac' > "$fake_bin/systemctl"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'printf "fake journal: unit=%s crashed after restart\\n" "${2:-unknown}"' > "$fake_bin/journalctl"
chmod +x -- "$fake_bin/sudo" "$fake_bin/systemctl" "$fake_bin/journalctl"
export PATH="$fake_bin:$PATH"
export BELT_DEPLOY_SYSTEMCTL_STATE="$fake_state"
for unit in multica-relay-advance gsp-multica-worker gsp-multica-worker-ppp \
  multica-cicd-worker multica-archiver gsp-multica-bridge; do
  printf '1000|active|running|Mon 2026-09-07 13:30:00 UTC\n' > "$fake_state/$unit.state"
done

# Expectations come from the canonical manifest, never a second copy of it.
runtime_root="$tmp_dir"
. "$root_dir/belt-manifest.sh"
[[ "${#sources[@]}" -eq "${#targets[@]}" ]] || { echo 'manifest arrays are not index-aligned' >&2; exit 1; }

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
    guardrails.cjs|parked-diagnosis.cjs|parked-entry-audit.cjs|relay-dead-rows.cjs|relay-completion-admission.cjs) return 0 ;;
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

dry_log="$tmp_dir/dry-run.log"
BELT_DEPLOY_RUNTIME_ROOT="$tmp_dir" "$root_dir/deploy.sh" --dry-run >"$dry_log"
grep -q "Would copy .*/parked-diagnosis.cjs to $bridge_dir/parked-diagnosis.cjs" "$dry_log"
grep -q "Would copy .*/parked-diagnosis.cjs to $relay_dir/parked-diagnosis.cjs" "$dry_log"
grep -q "Would copy .*/parity/relay-dead-rows.cjs to .*/parity/relay-dead-rows.cjs" "$dry_log"
# transition-policy.cjs ships to three service directories from one source row.
[[ "$(grep -c 'Would copy .*/transition-policy.cjs' "$dry_log")" -eq 3 ]]
grep -q '^Would restart gsp-multica-bridge$' "$dry_log"
grep -q '^Would restart multica-relay-advance$' "$dry_log"
[[ "$(grep -c '^Would restart ' "$dry_log")" -eq 2 ]]

# An unscoped apply rewrites every managed target, so it must be requested by name.
if BELT_DEPLOY_RUNTIME_ROOT="$tmp_dir" "$root_dir/deploy.sh" --apply >"$tmp_dir/unscoped.log" 2>&1; then
  echo 'expected refusal of an unscoped --apply' >&2
  exit 1
fi
grep -q 'Refusing an unscoped --apply' "$tmp_dir/unscoped.log"

# A partial rollout can leave the wrapper absent. It is a named parity target and
# must be recreated by a selective deployment.
rm -f -- "$worker_dir/multica-daemon-wrapper.sh"
BELT_DEPLOY_RUNTIME_ROOT="$tmp_dir" "$root_dir/deploy.sh" --apply --only multica-daemon-wrapper.sh >"$tmp_dir/missing-wrapper.log"
cmp -s -- "$root_dir/multica-daemon-wrapper.sh" "$worker_dir/multica-daemon-wrapper.sh"
grep -q "Copied .*/multica-daemon-wrapper.sh to $worker_dir/multica-daemon-wrapper.sh" "$tmp_dir/missing-wrapper.log"
grep -q '^Restarted gsp-multica-worker: 1000 -> 1100 ' "$tmp_dir/missing-wrapper.log"
grep -q '^Restarted gsp-multica-worker-ppp: 1000 -> 1100 ' "$tmp_dir/missing-wrapper.log"

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
receipt="$(sed -n 's/^Rollback receipt: .* --rollback \([0-9T]*Z\)$/\1/p' "$apply_log")"
[[ "$receipt" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || { echo 'missing rollback receipt' >&2; exit 1; }
BELT_DEPLOY_RUNTIME_ROOT="$tmp_dir" "$root_dir/deploy.sh" --rollback "$receipt" >/dev/null
for suffix in guardrails.cjs parked-diagnosis.cjs parked-entry-audit.cjs relay-completion-admission.cjs; do
  [[ ! -e "$bridge_dir/$suffix" ]] || { echo "rollback did not remove $suffix" >&2; exit 1; }
  [[ ! -e "$relay_dir/$suffix" ]] || { echo "rollback did not remove relay copy of $suffix" >&2; exit 1; }
done
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
node -e 'const r=require(process.argv[1]);if(r.restarted_units.length!==1||r.restarted_units[0].unit!=="multica-cicd-worker"||r.restarted_units[0].pid<=0)process.exit(1)' \
  "$tmp_dir/gsp-multica/deploy-receipts/belt-$selective_receipt.json"
BELT_DEPLOY_RUNTIME_ROOT="$tmp_dir" "$root_dir/deploy.sh" --rollback "$selective_receipt" --only multica-cicd-worker >/dev/null

# A no-op apply and an explicit copy-only apply must restart nothing.
BELT_DEPLOY_RUNTIME_ROOT="$tmp_dir" "$root_dir/deploy.sh" --apply --only multica-bridge.cjs > "$tmp_dir/noop.log"
grep -q '^No processes were restarted.$' "$tmp_dir/noop.log"
noop_receipt="$(sed -n 's/^Rollback receipt: .* --rollback \([0-9T]*Z\) --only multica-bridge.cjs$/\1/p' "$tmp_dir/noop.log")"
node -e 'const r=require(process.argv[1]);if(r.restarted_units.length!==0)process.exit(1)' \
  "$tmp_dir/gsp-multica/deploy-receipts/belt-$noop_receipt.json"
restart_count="$(wc -l < "$fake_state/restarts.log")"
printf '\nstale-runtime\n' >> "$tmp_dir/multica-archiver/multica-archiver.cjs"
BELT_DEPLOY_RUNTIME_ROOT="$tmp_dir" "$root_dir/deploy.sh" --apply --no-restart --only multica-archiver > "$tmp_dir/no-restart.log"
[[ "$restart_count" -eq "$(wc -l < "$fake_state/restarts.log")" ]]
grep -q '^Restarts disabled (--no-restart).$' "$tmp_dir/no-restart.log"

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
