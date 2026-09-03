#!/usr/bin/env bash
set -Eeuo pipefail
root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$root_dir/../.." && pwd)"
node "$root_dir/multica-cicd-worker.test.cjs"
node "$root_dir/deploy-decision.test.cjs"
bash -n "$root_dir/deploy.sh"
tmp_dir="$(mktemp -d)"; trap 'rm -rf -- "$tmp_dir"' EXIT
main_sha="$(git -C "$repo_root" rev-parse origin/main)"
old_sha="$(git -C "$repo_root" log -n 2 --format=%H -- ops/belt/multica-bridge.cjs | tail -1)"
[[ "$old_sha" != "$main_sha" ]] || { echo 'test needs an older bridge revision' >&2; exit 1; }
mkdir -p "$tmp_dir/gsp-multica/parity" "$tmp_dir/gsp-multica/fleet" "$tmp_dir/tools" "$tmp_dir/multica-doctrine"
declare -a files=('gsp-multica/multica-bridge.cjs' 'gsp-multica/guardrails.cjs' 'gsp-multica/parked-diagnosis.cjs' 'gsp-multica/parked-entry-audit.cjs' 'gsp-multica/parity/multica-relay-advance-daemon.cjs' 'gsp-multica/parity/relay-dead-rows.cjs' 'multica-cicd-worker.cjs' 'cicd-deploy-evidence.cjs' 'multica-archiver.cjs' 'tools/belt-config-guard.sh' 'gsp-multica/fleet/multica-daemon-wrapper.sh' 'gsp-multica/fleet/ecosystem.gsp-belt.config.js' 'tools/multica-bundle.py' 'multica-doctrine/RUNBOOK_SPEC_WORKER.md' 'multica-doctrine/RUNBOOK_BUILD_WORKER.md' 'multica-doctrine/RUNBOOK_QC_WORKER.md' 'multica-doctrine/WORKER_COMMON.md' 'gsp-multica/relay-completion-admission.cjs' 'gsp-multica/qc-lane.cjs' 'gsp-multica/reconciler.cjs' 'gsp-multica/stage-outcome.cjs' 'gsp-multica/transition-policy.cjs' 'gsp-multica/stage-routing.cjs' 'gsp-multica/qc-strict-evidence.cjs' 'gsp-multica/stage-routing.json' 'gsp-multica/qc-verdict-policy.cjs')
declare -a sources=('ops/belt/multica-bridge.cjs' 'ops/belt/guardrails.cjs' 'ops/belt/parked-diagnosis.cjs' 'ops/belt/parked-entry-audit.cjs' 'ops/belt/parity/multica-relay-advance-daemon.cjs' 'ops/belt/parity/relay-dead-rows.cjs' 'ops/belt/multica-cicd-worker.cjs' 'ops/belt/cicd-deploy-evidence.cjs' 'ops/belt/multica-archiver.cjs' 'ops/belt/belt-config-guard.sh' 'ops/belt/multica-daemon-wrapper.sh' 'ops/belt/ecosystem.gsp-belt.config.js' 'ops/belt/multica-bundle.py' 'ops/belt/RUNBOOK_SPEC_WORKER.md' 'ops/belt/RUNBOOK_BUILD_WORKER.md' 'ops/belt/RUNBOOK_QC_WORKER.md' 'ops/belt/WORKER_COMMON.md' 'ops/belt/relay-completion-admission.cjs' 'ops/belt/qc-lane.cjs' 'ops/belt/reconciler.cjs' 'ops/belt/stage-outcome.cjs' 'ops/belt/transition-policy.cjs' 'ops/belt/stage-routing.cjs' 'ops/belt/qc-strict-evidence.cjs' 'ops/belt/stage-routing.json' 'ops/belt/qc-verdict-policy.cjs')
for i in "${!files[@]}"; do git -C "$repo_root" show "$main_sha:${sources[$i]}" > "$tmp_dir/${files[$i]}"; done
git -C "$repo_root" show "$old_sha:ops/belt/multica-bridge.cjs" > "$tmp_dir/gsp-multica/multica-bridge.cjs"
mkdir -p "$tmp_dir/gsp-multica/deploy-receipts"
printf '{"repo":"timrecursify/multica","source_sha":"%s","outcome":"deployed"}\n' "$old_sha" > "$tmp_dir/gsp-multica/deploy-receipts/belt-old.json"
BELT_DEPLOY_RUNTIME_ROOT="$tmp_dir" "$root_dir/deploy.sh" --apply --source-commit 0000000000000000000000000000000000000000 > "$tmp_dir/deploy.log"
git -C "$repo_root" show "$main_sha:ops/belt/multica-bridge.cjs" | cmp -s - "$tmp_dir/gsp-multica/multica-bridge.cjs"
grep -Fq "Copied ops/belt/multica-bridge.cjs@$main_sha" "$tmp_dir/deploy.log"
grep -Fq "\"source_sha\":\"$main_sha\"" "$(sed -n 's/^Receipt: //p' "$tmp_dir/deploy.log")"
printf 'unexplained local edit\n' >> "$tmp_dir/gsp-multica/multica-bridge.cjs"
if BELT_DEPLOY_RUNTIME_ROOT="$tmp_dir" "$root_dir/deploy.sh" --apply --source-commit "$main_sha" > "$tmp_dir/refuse.log" 2>&1; then echo 'expected divergent runtime refusal' >&2; exit 1; fi
grep -Fq 'refused: live_runtime_diverged' "$tmp_dir/refuse.log"
grep -Fq '"refused":"live_runtime_diverged"' "$(sed -n 's/^Receipt: //p' "$tmp_dir/refuse.log")"
git -C "$repo_root" show "$main_sha:ops/belt/multica-bridge.cjs" > "$tmp_dir/gsp-multica/multica-bridge.cjs"
BELT_DEPLOY_RUNTIME_ROOT="$tmp_dir" "$root_dir/deploy.sh" --apply --source-commit "$old_sha" > "$tmp_dir/noop.log"
grep -Fq 'No-op: live runtime already equals origin/main.' "$tmp_dir/noop.log"
echo 'deploy guard test passed'
