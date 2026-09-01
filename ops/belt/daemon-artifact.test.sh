#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"; tmp="$(mktemp -d)"; trap 'rm -rf -- "$tmp"' EXIT
sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; mkdir -p "$tmp/artifact" "$tmp/runtime" "$tmp/proc/77"
cat >"$tmp/artifact/multica-linux-amd64" <<EOF
#!/usr/bin/env bash
case "\$*" in 'version --output json') printf '{\n  "commit": "$sha"\n}\n';; 'daemon status') exit 0;; esac
EOF
cat >"$tmp/old-server" <<'EOF'
#!/usr/bin/env bash
case "$*" in 'version --output json') printf '{"commit":"old"}\n';; 'daemon status') exit 0;; esac
EOF
chmod 0755 "$tmp/artifact/multica-linux-amd64" "$tmp/old-server"
sum="$(sha256sum "$tmp/artifact/multica-linux-amd64"|awk '{print $1}')"; old_sum="$(sha256sum "$tmp/old-server"|awk '{print $1}')"
manifest(){ printf 'SOURCE_SHA=%s\nBINARY_SHA256=%s\nGOOS=linux\nGOARCH=amd64\n' "$sha" "$sum" >"$tmp/artifact/daemon-artifact.env"; }
cat >"$tmp/pm2" <<'EOF'
#!/usr/bin/env bash
set -eu
count_file="$TEST_ROOT/reloads"; count=0; [[ -f "$count_file" ]] && count="$(<"$count_file")"
case "$1" in
  jlist)
    pid=77; restarts=0
    if [[ "${CRASH_LOOP:-0}" == 1 && "$count" -eq 1 ]]; then restarts=1; fi
    if [[ "${WRONG_PID:-0}" == 1 && "$count" -eq 1 ]]; then pid=88; fi
    printf '[{"name":"gsp-multica-worker","pid":%s,"pm2_env":{"status":"online","unstable_restarts":%s}}]' "$pid" "$restarts";;
  reload)
    count=$((count+1)); printf '%s' "$count" >"$count_file"
    if [[ "${CORRUPT_BACKUP:-0}" == 1 && "$count" -eq 1 ]]; then for backup in "$(dirname "$TARGET")"/"$(basename "$TARGET")".bak-*; do printf corrupt >"$backup"; done; fi
    if [[ ( "${RELOAD_FAIL:-0}" == 1 && "$count" -eq 1 ) || ( "${ROLLBACK_RELOAD_FAIL:-0}" == 1 && "$count" -gt 1 ) ]]; then exit 1; fi
    cp "$TARGET" "$PROC_ROOT/77/exe"
    if [[ "${SINGLE_ARG:-0}" == 1 && "$count" -eq 1 ]]; then printf '%s\0daemon start\0--max-concurrent-tasks=32\0' "$TARGET" >"$PROC_ROOT/77/cmdline"; elif [[ "${WRONG_CAP:-0}" == 1 && "$count" -eq 1 ]]; then printf '%s\0daemon\0start\0--max-concurrent-tasks=320\0' "$TARGET" >"$PROC_ROOT/77/cmdline"; else printf '%s\0daemon\0start\0--max-concurrent-tasks=32\0' "$TARGET" >"$PROC_ROOT/77/cmdline"; fi;;
esac
EOF
chmod +x "$tmp/pm2"
reset(){ cp "$tmp/old-server" "$tmp/runtime/server"; cp "$tmp/old-server" "$tmp/proc/77/exe"; printf '%s\0daemon\0start\0--max-concurrent-tasks=32\0' "$tmp/runtime/server" >"$tmp/proc/77/cmdline"; : >"$tmp/reloads"; manifest; }
run_case(){ local name="$1" want="$2" expect_target="$3"; shift 3; reset; set +e; env TEST_ROOT="$tmp" TARGET="$tmp/runtime/server" PROC_ROOT="$tmp/proc" MULTICA_DAEMON_TARGET="$tmp/runtime/server" PM2_BIN="$tmp/pm2" "$@" "$root/deploy-daemon-artifact.sh" --artifact-dir "$tmp/artifact" --source-sha "$sha" --apply >"$tmp/$name.out" 2>"$tmp/$name.err"; rc=$?; set -e; [[ "$rc" == "$want" ]] || { cat "$tmp/$name.err" >&2; exit 1; }; [[ "$(sha256sum "$tmp/runtime/server"|awk '{print $1}')" == "$expect_target" ]] || { echo "$name target mismatch" >&2; exit 1; }; }
run_case happy 0 "$sum"
run_case reload-failure 1 "$old_sum" RELOAD_FAIL=1
run_case crash-loop 1 "$old_sum" CRASH_LOOP=1
run_case wrong-pid 1 "$old_sum" WRONG_PID=1
run_case wrong-cap 1 "$old_sum" WRONG_CAP=1
run_case single-argv 1 "$old_sum" SINGLE_ARG=1
reset; lock="$tmp/deploy.lock"; flock "$lock" -c 'sleep 2' & holder=$!; sleep .1; set +e; TEST_ROOT="$tmp" TARGET="$tmp/runtime/server" PROC_ROOT="$tmp/proc" MULTICA_DAEMON_TARGET="$tmp/runtime/server" MULTICA_DAEMON_DEPLOY_LOCK="$lock" PM2_BIN="$tmp/pm2" "$root/deploy-daemon-artifact.sh" --artifact-dir "$tmp/artifact" --source-sha "$sha" --apply >/dev/null 2>&1; rc=$?; set -e; wait "$holder"; [[ "$rc" == 78 && "$(sha256sum "$tmp/runtime/server"|awk '{print $1}')" == "$old_sum" ]]
run_case corrupt-backup 79 "$sum" CORRUPT_BACKUP=1 WRONG_CAP=1
run_case rollback-reload-failure 79 "$old_sum" ROLLBACK_RELOAD_FAIL=1 WRONG_CAP=1
printf 'SOURCE_SHA=%s;touch pwned\nBINARY_SHA256=%s\nGOOS=linux\nGOARCH=amd64\n' "$sha" "$sum" >"$tmp/artifact/daemon-artifact.env"
cp "$tmp/old-server" "$tmp/runtime/server"
set +e; TEST_ROOT="$tmp" TARGET="$tmp/runtime/server" PROC_ROOT="$tmp/proc" MULTICA_DAEMON_TARGET="$tmp/runtime/server" PM2_BIN="$tmp/pm2" "$root/deploy-daemon-artifact.sh" --artifact-dir "$tmp/artifact" --source-sha "$sha" --apply >/dev/null 2>&1; rc=$?; set -e
[[ "$rc" == 78 && "$(sha256sum "$tmp/runtime/server"|awk '{print $1}')" == "$old_sum" ]]
echo 'daemon artifact deploy success and six rollback/health failure tests passed'
