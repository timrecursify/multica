#!/usr/bin/env bash
set -Eeuo pipefail

root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf -- "$tmp_dir"' EXIT
mkdir -p "$tmp_dir/gsp-multica/parity" "$tmp_dir/tools" "$tmp_dir/multica-doctrine"

declare -a files=(
  "gsp-multica/multica-bridge.cjs"
  "gsp-multica/guardrails.cjs"
  "gsp-multica/parity/multica-relay-advance-daemon.cjs"
  "multica-cicd-worker.cjs"
  "tools/belt-config-guard.sh"
  "tools/multica-bundle.py"
  "multica-doctrine/RUNBOOK_SPEC_WORKER.md"
  "multica-doctrine/RUNBOOK_BUILD_WORKER.md"
  "multica-doctrine/WORKER_COMMON.md"
)

for rel in "${files[@]}"; do
  [[ "$rel" == gsp-multica/guardrails.cjs ]] && continue
  source_file="$root_dir/${rel##*/}"
  [[ "$rel" == gsp-multica/parity/* ]] && source_file="$root_dir/parity/${rel##*/}"
  target="$tmp_dir/$rel"
  cp -- "$source_file" "$target"
  printf 'original:%s\n' "$rel" >> "$tmp_dir/originals"
done

if BELT_DEPLOY_RUNTIME_ROOT="$tmp_dir" BELT_DEPLOY_FAIL_INDEX=2 \
   "$root_dir/deploy.sh" --apply >"$tmp_dir/fail.log" 2>&1; then
  echo 'expected injected deployment failure' >&2
  exit 1
fi
for rel in "${files[@]}"; do
  target="$tmp_dir/$rel"
  if [[ "$rel" == gsp-multica/guardrails.cjs ]]; then
    [[ ! -e "$target" ]] || { echo "new target survived rollback: $rel" >&2; exit 1; }
  else
    source_file="$root_dir/${rel##*/}"
    [[ "$rel" == gsp-multica/parity/* ]] && source_file="$root_dir/parity/${rel##*/}"
    cmp -s -- "$source_file" "$target" || { echo "target not restored: $rel" >&2; exit 1; }
  fi
done

apply_log="$tmp_dir/apply.log"
BELT_DEPLOY_RUNTIME_ROOT="$tmp_dir" "$root_dir/deploy.sh" --apply >"$apply_log"
receipt="$(sed -n 's/^Rollback receipt: .* --rollback \([0-9T]*Z\)$/\1/p' "$apply_log")"
[[ "$receipt" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || { echo 'missing rollback receipt' >&2; exit 1; }
BELT_DEPLOY_RUNTIME_ROOT="$tmp_dir" "$root_dir/deploy.sh" --rollback "$receipt" >/dev/null
[[ ! -e "$tmp_dir/gsp-multica/guardrails.cjs" ]] || { echo 'rollback did not remove new target' >&2; exit 1; }
echo 'deploy rollback test passed'
