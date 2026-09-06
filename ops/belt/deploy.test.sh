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

# Expectations come from the canonical manifest, never a second copy of it.
runtime_root="$tmp_dir"
. "$root_dir/belt-manifest.sh"
[[ "${#sources[@]}" -eq "${#targets[@]}" ]] || { echo 'manifest arrays are not index-aligned' >&2; exit 1; }

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
BELT_DEPLOY_RUNTIME_ROOT="$tmp_dir" "$root_dir/deploy.sh" --rollback "$selective_receipt" --only multica-cicd-worker >/dev/null

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
echo 'deploy rollback test passed'
