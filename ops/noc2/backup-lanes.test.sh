#!/usr/bin/env bash
set -Eeuo pipefail
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
cat >"$tmp/config" <<'EOF'
LANES="ok broken"
LANE_ok_REPOSITORY="repo-ok"
LANE_ok_ENV_FILE=""
LANE_broken_REPOSITORY="repo-broken"
EOF
cat >"$tmp/query" <<'EOF'
#!/usr/bin/env bash
[[ $2 == repo-ok ]] && { echo 42; exit 0; }
exit 1
EOF
chmod +x "$tmp/query"
out=$(GSP_BACKUP_LANES_CONFIG="$tmp/config" GSP_BACKUP_AGE_QUERY="$tmp/query" "$root/gsp-backup-age-emitter.sh")
grep -q 'backup_lane_age_seconds{lane="ok"} 42' <<<"$out"
grep -q 'backup_lane_query_ok{lane="ok"} 1' <<<"$out"
grep -q 'backup_lane_query_ok{lane="broken"} 0' <<<"$out"
[[ $(grep -c '^backup_lane_age_seconds' <<<"$out") -eq 2 ]]
echo PASS
