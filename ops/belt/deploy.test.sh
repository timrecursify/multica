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
mkdir -p "$tmp_dir/gsp-multica/parity" "$tmp_dir/gsp-multica/fleet" "$tmp_dir/tools" "$tmp_dir/multica-doctrine"

declare -a files=(
  "gsp-multica/multica-bridge.cjs"
  "gsp-multica/guardrails.cjs"
  "gsp-multica/parked-diagnosis.cjs"
  "gsp-multica/parked-runtime-verification.cjs"
  "gsp-multica/parked-entry-audit.cjs"
  "gsp-multica/parity/multica-relay-advance-daemon.cjs"
  "gsp-multica/parity/relay-dead-rows.cjs"
  "multica-cicd-worker.cjs"
  "cicd-deploy-evidence.cjs"
  "multica-archiver.cjs"
  "tools/belt-config-guard.sh"
  "gsp-multica/fleet/multica-daemon-wrapper.sh"
  "gsp-multica/fleet/ecosystem.gsp-belt.config.js"
  "tools/multica-bundle.py"
  "multica-doctrine/RUNBOOK_SPEC_WORKER.md"
  "multica-doctrine/RUNBOOK_BUILD_WORKER.md"
  "multica-doctrine/RUNBOOK_QC_WORKER.md"
  "multica-doctrine/WORKER_COMMON.md"
  "gsp-multica/relay-completion-admission.cjs"
)

for rel in "${files[@]}"; do
  [[ "$rel" == gsp-multica/guardrails.cjs || "$rel" == gsp-multica/parked-diagnosis.cjs || "$rel" == gsp-multica/parked-runtime-verification.cjs || "$rel" == gsp-multica/parked-entry-audit.cjs || "$rel" == gsp-multica/parity/relay-dead-rows.cjs || "$rel" == cicd-deploy-evidence.cjs || "$rel" == gsp-multica/relay-completion-admission.cjs ]] && continue
  source_file="$root_dir/${rel##*/}"
  [[ "$rel" == gsp-multica/parity/* ]] && source_file="$root_dir/parity/${rel##*/}"
  [[ "$rel" == gsp-multica/fleet/* ]] && source_file="$root_dir/${rel##*/}"
  target="$tmp_dir/$rel"
  cp -- "$source_file" "$target"
  printf 'original:%s\n' "$rel" >> "$tmp_dir/originals"
done

dry_log="$tmp_dir/dry-run.log"
BELT_DEPLOY_RUNTIME_ROOT="$tmp_dir" "$root_dir/deploy.sh" --dry-run >"$dry_log"
grep -q 'Would copy .*/parked-diagnosis.cjs to .*/gsp-multica/parked-diagnosis.cjs' "$dry_log"
grep -q 'Would copy .*/parked-runtime-verification.cjs to .*/gsp-multica/parked-runtime-verification.cjs' "$dry_log"
grep -q 'Would copy .*/parked-entry-audit.cjs to .*/gsp-multica/parked-entry-audit.cjs' "$dry_log"
grep -q 'Would copy .*/parity/relay-dead-rows.cjs to .*/gsp-multica/parity/relay-dead-rows.cjs' "$dry_log"
grep -q 'parity/relay-dead-rows.cjs' "$root_dir/verify.sh"
grep -q 'Would copy .*/cicd-deploy-evidence.cjs to .*/cicd-deploy-evidence.cjs' "$dry_log"

# Remove the dependency from a disposable manifest copy. Validation must fail
# before copy, proving the deploy cannot restart with an incomplete runtime.
manifest_dir="$tmp_dir/manifest"
cp -a -- "$root_dir/." "$manifest_dir/"
sed -i '/parked-diagnosis\.cjs/d' "$manifest_dir/deploy.sh"
if BELT_DEPLOY_RUNTIME_ROOT="$tmp_dir" "$manifest_dir/deploy.sh" --apply >"$tmp_dir/missing-dependency.log" 2>&1; then
  echo 'expected missing runtime dependency rejection' >&2
  exit 1
fi
grep -q 'Missing manifest runtime dependency:' "$tmp_dir/missing-dependency.log"
grep -q 'Would\|Copied\|Backed up' "$tmp_dir/missing-dependency.log" && {
  echo 'manifest validation ran after deployment work' >&2
  exit 1
}

if BELT_DEPLOY_RUNTIME_ROOT="$tmp_dir" BELT_DEPLOY_FAIL_INDEX=2 \
   "$root_dir/deploy.sh" --apply >"$tmp_dir/fail.log" 2>&1; then
  echo 'expected injected deployment failure' >&2
  exit 1
fi
for rel in "${files[@]}"; do
  target="$tmp_dir/$rel"
  if [[ "$rel" == gsp-multica/guardrails.cjs || "$rel" == gsp-multica/parked-diagnosis.cjs || "$rel" == gsp-multica/parked-runtime-verification.cjs || "$rel" == gsp-multica/parked-entry-audit.cjs || "$rel" == gsp-multica/parity/relay-dead-rows.cjs || "$rel" == cicd-deploy-evidence.cjs || "$rel" == gsp-multica/relay-completion-admission.cjs ]]; then
    [[ ! -e "$target" ]] || { echo "new target survived rollback: $rel" >&2; exit 1; }
  else
    source_file="$root_dir/${rel##*/}"
    [[ "$rel" == gsp-multica/parity/* ]] && source_file="$root_dir/parity/${rel##*/}"
    [[ "$rel" == gsp-multica/fleet/* ]] && source_file="$root_dir/${rel##*/}"
    cmp -s -- "$source_file" "$target" || { echo "target not restored: $rel" >&2; exit 1; }
  fi
done

apply_log="$tmp_dir/apply.log"
BELT_DEPLOY_RUNTIME_ROOT="$tmp_dir" "$root_dir/deploy.sh" --apply >"$apply_log"
BELT_DEPLOY_RUNTIME_ROOT="$tmp_dir" "$root_dir/verify.sh" >"$tmp_dir/verify.log"
grep -q "Match: $tmp_dir/cicd-deploy-evidence.cjs" "$tmp_dir/verify.log"
receipt="$(sed -n 's/^Rollback receipt: .* --rollback \([0-9T]*Z\)$/\1/p' "$apply_log")"
[[ "$receipt" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || { echo 'missing rollback receipt' >&2; exit 1; }
BELT_DEPLOY_RUNTIME_ROOT="$tmp_dir" "$root_dir/deploy.sh" --rollback "$receipt" >/dev/null
[[ ! -e "$tmp_dir/gsp-multica/guardrails.cjs" ]] || { echo 'rollback did not remove new target' >&2; exit 1; }
[[ ! -e "$tmp_dir/gsp-multica/parked-diagnosis.cjs" ]] || { echo 'rollback did not remove parked diagnosis target' >&2; exit 1; }
[[ ! -e "$tmp_dir/gsp-multica/parked-runtime-verification.cjs" ]] || { echo 'rollback did not remove parked verification target' >&2; exit 1; }
[[ ! -e "$tmp_dir/gsp-multica/parked-entry-audit.cjs" ]] || { echo 'rollback did not remove parked entry audit target' >&2; exit 1; }
[[ ! -e "$tmp_dir/gsp-multica/parity/relay-dead-rows.cjs" ]] || { echo 'rollback did not remove relay dead rows target' >&2; exit 1; }
[[ ! -e "$tmp_dir/cicd-deploy-evidence.cjs" ]] || { echo 'rollback did not remove deploy evidence target' >&2; exit 1; }
[[ ! -e "$tmp_dir/gsp-multica/relay-completion-admission.cjs" ]] || { echo 'rollback did not remove completion admission target' >&2; exit 1; }

before_bridge="$(sha256sum "$tmp_dir/gsp-multica/multica-bridge.cjs")"
cp -- "$root_dir/cicd-deploy-evidence.cjs" "$tmp_dir/cicd-deploy-evidence.cjs"
printf '\nstale-runtime\n' >> "$tmp_dir/multica-cicd-worker.cjs"
BELT_DEPLOY_RUNTIME_ROOT="$tmp_dir" "$root_dir/deploy.sh" --apply --only multica-cicd-worker >"$tmp_dir/selective.log"
cmp -s -- "$root_dir/multica-cicd-worker.cjs" "$tmp_dir/multica-cicd-worker.cjs"
[[ "$before_bridge" == "$(sha256sum "$tmp_dir/gsp-multica/multica-bridge.cjs")" ]]
grep -q 'Backed up .*/multica-cicd-worker.cjs' "$tmp_dir/selective.log"
grep -q 'Copied .*/multica-cicd-worker.cjs to .*/multica-cicd-worker.cjs' "$tmp_dir/selective.log"
if grep -q 'relay-dead-rows.cjs' "$tmp_dir/selective.log"; then
  echo '--only multica-cicd-worker selected relay-dead-rows.cjs' >&2
  exit 1
fi
[[ "$(grep -c '^Backed up ' "$tmp_dir/selective.log")" -eq 1 ]]
selective_receipt="$(sed -n 's/^Rollback receipt: .* --rollback \([0-9T]*Z\) --only multica-cicd-worker$/\1/p' "$tmp_dir/selective.log")"
[[ "$selective_receipt" =~ ^[0-9]{8}T[0-9]{6}Z$ ]]
BELT_DEPLOY_RUNTIME_ROOT="$tmp_dir" "$root_dir/deploy.sh" --rollback "$selective_receipt" --only multica-cicd-worker >/dev/null
echo 'deploy rollback test passed'
