#!/usr/bin/env bash
set -euo pipefail
root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf -- "$tmp"' EXIT
mkdir -p "$tmp/artifact" "$tmp/runtime"
cat >"$tmp/artifact/multica-linux-amd64" <<'EOF'
#!/usr/bin/env bash
if [[ "$*" == 'version --output json' ]]; then printf '{\n  "commit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"\n}\n'; fi
EOF
chmod 0755 "$tmp/artifact/multica-linux-amd64"
sha="$(sha256sum "$tmp/artifact/multica-linux-amd64" | awk '{print $1}')"
printf 'SOURCE_SHA=%s\nBINARY_SHA256=%s\nGOOS=linux\nGOARCH=amd64\n' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa "$sha" >"$tmp/artifact/daemon-artifact.env"
cp "$tmp/artifact/multica-linux-amd64" "$tmp/runtime/server"
cat >"$tmp/pm2" <<'EOF'
#!/usr/bin/env bash
[[ "$*" == 'reload gsp-multica-worker --update-env' ]]
EOF
chmod 0755 "$tmp/pm2"
cat >"$tmp/ps" <<'EOF'
#!/usr/bin/env bash
printf '/tmp/runtime/server daemon start --foreground --max-concurrent-tasks=32\n'
EOF
chmod 0755 "$tmp/ps"
MULTICA_DAEMON_TARGET="$tmp/runtime/server" PM2_BIN="$tmp/pm2" PS_BIN="$tmp/ps" "$root_dir/deploy-daemon-artifact.sh" --artifact-dir "$tmp/artifact" --source-sha aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --apply >"$tmp/receipt"
grep -Fq '"health":"ok"' "$tmp/receipt"
cmp -s "$tmp/artifact/multica-linux-amd64" "$tmp/runtime/server"
test -f "$tmp/runtime/server.bak-$(date -u +%Y%m%d)"* || { echo 'backup not created' >&2; exit 1; }
echo 'daemon artifact deploy verifies exact SHA, preserves concurrency argv, and writes backup receipt'
