#!/usr/bin/env bash
set -Eeuo pipefail

mode="dry-run"

case "${1:---dry-run}" in
  --dry-run)
    ;;
  --apply)
    mode="apply"
    ;;
  *)
    printf 'Usage: %s [--dry-run|--apply]\n' "$0" >&2
    exit 2
    ;;
esac

if [[ $# -gt 1 ]]; then
  printf 'Usage: %s [--dry-run|--apply]\n' "$0" >&2
  exit 2
fi

root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"

declare -a sources=(
  "$root_dir/multica-bridge.cjs"
  "$root_dir/guardrails.cjs"
  "$root_dir/parity/multica-relay-advance-daemon.cjs"
  "$root_dir/multica-cicd-worker.cjs"
  "$root_dir/belt-config-guard.sh"
  "$root_dir/multica-bundle.py"
  "$root_dir/RUNBOOK_SPEC_WORKER.md"
  "$root_dir/RUNBOOK_BUILD_WORKER.md"
  "$root_dir/WORKER_COMMON.md"
)

declare -a targets=(
  "/home/newadmin/gsp-multica/multica-bridge.cjs"
  "/home/newadmin/gsp-multica/guardrails.cjs"
  "/home/newadmin/gsp-multica/parity/multica-relay-advance-daemon.cjs"
  "/home/newadmin/multica-cicd-worker.cjs"
  "/home/newadmin/tools/belt-config-guard.sh"
  "/home/newadmin/tools/multica-bundle.py"
  "/home/newadmin/multica-doctrine/RUNBOOK_SPEC_WORKER.md"
  "/home/newadmin/multica-doctrine/RUNBOOK_BUILD_WORKER.md"
  "/home/newadmin/multica-doctrine/WORKER_COMMON.md"
)

invalid=0
for index in "${!sources[@]}"; do
  if [[ ! -f "${sources[$index]}" ]]; then
    printf 'Missing repository file: %s\n' "${sources[$index]}" >&2
    invalid=1
  fi
  if [[ ! -f "${targets[$index]}" ]]; then
    printf 'Missing runtime file: %s\n' "${targets[$index]}" >&2
    invalid=1
  fi
done

if (( invalid )); then
  exit 1
fi

for index in "${!sources[@]}"; do
  source_file="${sources[$index]}"
  target_file="${targets[$index]}"
  backup_file="${target_file}.bak-${timestamp}"

  if [[ "$mode" == "dry-run" ]]; then
    printf 'Would back up %s to %s\n' "$target_file" "$backup_file"
    printf 'Would copy %s to %s\n' "$source_file" "$target_file"
    continue
  fi

  cp --preserve=mode -- "$target_file" "$backup_file"
  cp --preserve=mode -- "$source_file" "$target_file"
  printf 'Backed up %s to %s\n' "$target_file" "$backup_file"
  printf 'Copied %s to %s\n' "$source_file" "$target_file"
done

printf 'No processes were restarted.\n'
