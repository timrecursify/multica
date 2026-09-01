#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"; tmp="$(mktemp -d)"; trap 'rm -rf -- "$tmp"' EXIT
sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; mkdir -p "$tmp/artifact" "$tmp/runtime" "$tmp/proc/77"
cat >"$tmp/artifact/multica-linux-amd64" <<EOF
#!/usr/bin/env bash
case "\$*" in 'version --output json') printf '{\n  "commit": "$sha"\n}\n';; 'daemon status') exit 0;; esac
EOF
chmod 0755 "$tmp/artifact/multica-linux-amd64"; cp "$tmp/artifact/multica-linux-amd64" "$tmp/runtime/server"; cp "$tmp/artifact/multica-linux-amd64" "$tmp/proc/77/exe"; printf 'server daemon start --max-concurrent-tasks=32\0' >"$tmp/proc/77/cmdline"
sum="$(sha256sum "$tmp/artifact/multica-linux-amd64"|awk '{print $1}')"; printf 'SOURCE_SHA=%s\nBINARY_SHA256=%s\nGOOS=linux\nGOARCH=amd64\n' "$sha" "$sum" >"$tmp/artifact/daemon-artifact.env"
cat >"$tmp/pm2" <<'EOF'
#!/usr/bin/env bash
case "$1" in jlist) printf '[{"name":"gsp-multica-worker","pid":77,"pm2_env":{"status":"online","unstable_restarts":0}}]';; reload) exit 0;; esac
EOF
chmod +x "$tmp/pm2"
PROC_ROOT="$tmp/proc" MULTICA_DAEMON_TARGET="$tmp/runtime/server" PM2_BIN="$tmp/pm2" "$root/deploy-daemon-artifact.sh" --artifact-dir "$tmp/artifact" --source-sha "$sha" --apply >"$tmp/receipt"
grep -Fq '"health":"ok"' "$tmp/receipt"
printf 'SOURCE_SHA=%s;touch pwned\nBINARY_SHA256=%s\nGOOS=linux\nGOARCH=amd64\n' "$sha" "$sum" >"$tmp/artifact/daemon-artifact.env"
if PROC_ROOT="$tmp/proc" MULTICA_DAEMON_TARGET="$tmp/runtime/server" PM2_BIN="$tmp/pm2" "$root/deploy-daemon-artifact.sh" --artifact-dir "$tmp/artifact" --source-sha "$sha" --apply; then exit 1; fi
echo 'daemon artifact deploy parser and process health tests passed'
