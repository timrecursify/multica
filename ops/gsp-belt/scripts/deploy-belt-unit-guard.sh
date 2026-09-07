#!/usr/bin/env bash
set -Eeuo pipefail
mode="${1:?mode required}"; source_commit="${2:?source commit required}"
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
units=(gsp-multica-bridge multica-relay-advance multica-archiver multica-cicd-worker gsp-multica-worker gsp-multica-worker-ppp)
sources=("$root/scripts/belt-unit-guard.sh" "$root/systemd/belt-unit-guard.service" "$root/systemd/belt-unit-guard.timer")
targets=(/usr/local/libexec/belt-unit-guard /etc/systemd/system/belt-unit-guard.service /etc/systemd/system/belt-unit-guard.timer)
for unit in "${units[@]}"; do sources+=("$root/systemd/belt-unit-guard.conf"); targets+=("/etc/systemd/system/$unit.service.d/belt-unit-guard.conf"); done
for i in "${!sources[@]}"; do
  if [[ "$mode" == dry-run ]]; then printf 'Would install %s to %s\n' "${sources[$i]}" "${targets[$i]}"; else install -D -m "$( [[ ${targets[$i]} == /usr/local/libexec/* ]] && echo 0755 || echo 0644 )" "${sources[$i]}" "${targets[$i]}"; fi
done
[[ "$mode" == apply ]] || exit 0
systemctl daemon-reload
systemctl enable --now belt-unit-guard.timer
receipt_dir=/opt/gsp/multica-workers/gsp-multica/deploy-receipts; mkdir -p -- "$receipt_dir"
receipt="$receipt_dir/belt-unit-guard-$(date -u +%Y%m%dT%H%M%SZ).json"
printf '{"repo":"timrecursify/multica","source_sha":"%s","component":"belt-unit-guard"}\n' "$source_commit" > "$receipt"
printf 'Receipt: %s\n' "$receipt"
