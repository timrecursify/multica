#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
conf="$root/multica-scratch.conf"
[[ -r "$conf" ]]
grep -Fq 'D /tmp/multica-task-* 0755 newadmin newadmin 2h' "$conf"
grep -Fq 'D /tmp/sk-multica-qc.* 0755 newadmin newadmin 2h' "$conf"
grep -Fq 'D /tmp/qc* 0755 newadmin newadmin 2h' "$conf"
grep -Fq 'D /tmp/pppqc 0755 newadmin newadmin 2h' "$conf"
! grep -Eq '^D /tmp[[:space:]]' "$conf"
printf 'NOC2 scratch tmpfiles policy passed\n'
