#!/usr/bin/env bash
set -Eeuo pipefail

root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

declare -a sources=(
  "$root_dir/multica-bridge.cjs"
  "$root_dir/guardrails.cjs"
  "$root_dir/parity/multica-relay-advance-daemon.cjs"
  "$root_dir/parity/relay-dead-rows.cjs"
  "$root_dir/multica-cicd-worker.cjs"
  "$root_dir/belt-config-guard.sh"
  "$root_dir/multica-daemon-wrapper.sh"
  "$root_dir/ecosystem.gsp-belt.config.js"
  "$root_dir/multica-bundle.py"
  "$root_dir/RUNBOOK_SPEC_WORKER.md"
  "$root_dir/RUNBOOK_BUILD_WORKER.md"
  "$root_dir/RUNBOOK_QC_WORKER.md"
  "$root_dir/WORKER_COMMON.md"
)

declare -a targets=(
  "/home/newadmin/gsp-multica/multica-bridge.cjs"
  "/home/newadmin/gsp-multica/guardrails.cjs"
  "/home/newadmin/gsp-multica/parity/multica-relay-advance-daemon.cjs"
  "/home/newadmin/gsp-multica/parity/relay-dead-rows.cjs"
  "/home/newadmin/multica-cicd-worker.cjs"
  "/home/newadmin/tools/belt-config-guard.sh"
  "/home/newadmin/gsp-multica/fleet/multica-daemon-wrapper.sh"
  "/home/newadmin/gsp-multica/fleet/ecosystem.gsp-belt.config.js"
  "/home/newadmin/tools/multica-bundle.py"
  "/home/newadmin/multica-doctrine/RUNBOOK_SPEC_WORKER.md"
  "/home/newadmin/multica-doctrine/RUNBOOK_BUILD_WORKER.md"
  "/home/newadmin/multica-doctrine/RUNBOOK_QC_WORKER.md"
  "/home/newadmin/multica-doctrine/WORKER_COMMON.md"
)

status=0
for index in "${!sources[@]}"; do
  source_file="${sources[$index]}"
  target_file="${targets[$index]}"

  if [[ ! -f "$source_file" ]]; then
    printf 'Missing repository file: %s\n' "$source_file" >&2
    status=1
    continue
  fi
  if [[ ! -f "$target_file" ]]; then
    printf 'Missing runtime file: %s\n' "$target_file" >&2
    status=1
    continue
  fi
  if cmp -s -- "$source_file" "$target_file"; then
    printf 'Match: %s\n' "$target_file"
  else
    printf 'Drift: %s\n' "$target_file" >&2
    status=1
  fi
done

exit "$status"
