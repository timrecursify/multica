#!/usr/bin/env bash
set -Eeuo pipefail
artifact_dir=""; expected_sha=""; apply=0
while (($#)); do case "$1" in --artifact-dir) artifact_dir="${2:-}"; shift 2;; --source-sha) expected_sha="${2:-}"; shift 2;; --apply) apply=1; shift;; *) exit 64;; esac; done
fail(){ echo "daemon artifact deploy: $*" >&2; exit 78; }
[[ $apply == 1 && "$expected_sha" =~ ^[0-9a-f]{40}$ ]] || fail "--apply and a 40-character --source-sha are required"
[[ "$artifact_dir" = /* && -d "$artifact_dir" && ! -L "$artifact_dir" && "$(realpath -e -- "$artifact_dir")" == "$artifact_dir" ]] || fail "artifact directory must be canonical"
manifest="$artifact_dir/daemon-artifact.env"; binary="$artifact_dir/multica-linux-amd64"
[[ -f "$manifest" && ! -L "$manifest" && -f "$binary" && ! -L "$binary" && -x "$binary" ]] || fail "artifact manifest or executable is missing"
declare -A m=()
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ "$line" =~ ^(SOURCE_SHA|BINARY_SHA256|GOOS|GOARCH)=([A-Za-z0-9._-]+)$ ]] || fail "invalid manifest line"
  key="${BASH_REMATCH[1]}"; value="${BASH_REMATCH[2]}"; [[ -z "${m[$key]+x}" ]] || fail "duplicate manifest key: $key"; m[$key]="$value"
done < "$manifest"
[[ ${#m[@]} == 4 && "${m[SOURCE_SHA]-}" == "$expected_sha" && "${m[BINARY_SHA256]-}" =~ ^[0-9a-f]{64}$ && "${m[GOOS]-}" == linux && "${m[GOARCH]-}" == amd64 ]] || fail "artifact identity does not match requested source SHA"
binary_sha="${m[BINARY_SHA256]}"
[[ "$(sha256sum "$binary" | awk '{print $1}')" == "$binary_sha" ]] || fail "artifact checksum mismatch"
"$binary" version --output json | grep -Fq "\"commit\": \"$expected_sha\"" || fail "artifact version does not carry requested source SHA"
target="${MULTICA_DAEMON_TARGET:-/home/newadmin/multica-daemon/server}"; pm2_bin="${PM2_BIN:-pm2}"; proc_root="${PROC_ROOT:-/proc}"; app="${MULTICA_DAEMON_PM2_APP:-gsp-multica-worker}"
[[ "$target" = /* && -f "$target" && ! -L "$target" ]] || fail "daemon target must be an existing regular absolute file"
lock_file="${MULTICA_DAEMON_DEPLOY_LOCK:-${target}.deploy.lock}"
exec 9>"$lock_file"
flock -n 9 || fail "another daemon artifact deployment holds the lock"
pm2_state(){ "$pm2_bin" jlist | node -e 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{let p=JSON.parse(s).find(x=>x.name===process.argv[1]);if(!p)process.exit(2);console.log([p.pid,p.pm2_env.status,p.pm2_env.unstable_restarts].join("|"))})' "$app"; }
initial="$(pm2_state)" || fail "PM2 app is absent"; IFS='|' read -r initial_pid initial_status initial_restarts <<<"$initial"
[[ "$initial_status" == online && "$initial_pid" =~ ^[1-9][0-9]*$ ]] || fail "PM2 app is not online"
health(){ local want="$1" state pid status restarts; local -a argv; state="$(pm2_state)" || return 1; IFS='|' read -r pid status restarts <<<"$state"; [[ "$pid" =~ ^[1-9][0-9]*$ && "$status" == online && "$restarts" == "$initial_restarts" && -r "$proc_root/$pid/cmdline" && -e "$proc_root/$pid/exe" ]] || return 1; mapfile -d '' -t argv < "$proc_root/$pid/cmdline"; local start=0 i; for ((i=0;i+2<${#argv[@]};i++)); do [[ "${argv[i]}" == server && "${argv[i+1]}" == daemon && "${argv[i+2]}" == start ]] && start=1; done; [[ $start == 1 ]] || return 1; local cap_count=0 arg; for arg in "${argv[@]}"; do [[ "$arg" == '--max-concurrent-tasks=32' ]] && ((cap_count+=1)); done; [[ $cap_count == 1 && "$(sha256sum "$proc_root/$pid/exe" | awk '{print $1}')" == "$want" ]] || return 1; "$target" daemon status >/dev/null 2>&1; }
target_dir="$(dirname "$target")"; stamp="$(date -u +%Y%m%dT%H%M%S%N)"; backup="${target}.bak-${stamp}-${expected_sha:0:12}"; receipt="${target}.deploy-${stamp}-${expected_sha:0:12}.json"; [[ ! -e "$backup" && ! -e "$receipt" ]] || fail "backup or receipt already exists"; old_sha="$(sha256sum "$target" | awk '{print $1}')"; tmp="$(mktemp "$target_dir/.server.${expected_sha}.XXXXXX")"
rollback(){ local rc="$1"
  [[ -f "$backup" && "$(sha256sum "$backup" | awk '{print $1}')" == "$old_sha" ]] || { echo 'daemon artifact deploy: rollback backup invalid' >&2; exit 79; }
  if ! cp --preserve=mode -- "$backup" "$tmp" || ! mv -f -- "$tmp" "$target"; then echo 'daemon artifact deploy: rollback file restore failed' >&2; exit 79; fi
  if ! "$pm2_bin" reload "$app" --update-env >/dev/null || ! health "$old_sha"; then echo 'daemon artifact deploy: rollback reload or health failed' >&2; exit 79; fi
  exit "$rc"
}
trap 'rm -f -- "$tmp"' EXIT
cp --preserve=mode -- "$target" "$backup"; [[ "$(sha256sum "$backup" | awk '{print $1}')" == "$old_sha" ]] || fail "backup verification failed"
cp --preserve=mode -- "$binary" "$tmp"; chmod 0755 -- "$tmp"; mv -f -- "$tmp" "$target"
"$pm2_bin" reload "$app" --update-env >/dev/null || rollback 1
sleep 2; health "$binary_sha" || rollback 1
set -C; printf '{"source_sha":"%s","binary_sha256":"%s","backup":"%s","app":"%s","health":"ok"}\n' "$expected_sha" "$binary_sha" "$backup" "$app" > "$receipt"; set +C
cat "$receipt"
