#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"; tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
sha="$(git -C "$root" rev-parse HEAD)"; mkdir -p "$tmp/bin" "$tmp/releases" "$tmp/receipts"
cat >"$tmp/bin/go" <<'EOF'
#!/usr/bin/env bash
while [[ $# -gt 0 ]]; do [[ "$1" == -o ]] && { shift; out="$1"; }; shift || true; done
printf '#!/usr/bin/env bash\nprintf "{\\"commit\\": \\"%s\\"}" "${GIT_FAKE_SHA:-unknown}"\n' > "$out"; chmod +x "$out"
EOF
chmod +x "$tmp/bin/go"
cat >"$tmp/bin/pm2" <<'EOF'
#!/usr/bin/env bash
case "$1" in jlist) printf '[{"name":"gsp-multica-bridge","pm2_env":{"status":"online","pm_cwd":"%s"}},{"name":"multica-relay-advance","pm2_env":{"status":"online","pm_cwd":"%s"}},{"name":"gsp-multica-worker","pm2_env":{"status":"online","pm_cwd":"%s"}},{"name":"multica-cicd-worker","pm2_env":{"status":"online","pm_cwd":"%s"}},{"name":"multica-archiver","pm2_env":{"status":"online","pm_cwd":"%s"}}]' "$EXPECT_RELEASE" "$EXPECT_RELEASE" "$EXPECT_RELEASE" "$EXPECT_RELEASE" "$EXPECT_RELEASE";; startOrReload) printf '%s %s\n' "${MULTICA_INCLUDE_WORKER:-0}" "${MULTICA_SKIP_CICD_WORKER:-0}" >> "$PM2_LOG";; *) exit 0;; esac
EOF
chmod +x "$tmp/bin/pm2"; export EXPECT_RELEASE="$tmp/releases/$sha" PM2_LOG="$tmp/pm2.log"
env PM2_BIN="$tmp/bin/pm2" MULTICA_RELEASE_ROOT="$tmp/releases" MULTICA_RECEIPT_ROOT="$tmp/receipts" "$root/ops/belt/deploy-release.sh" --preflight "$sha" >/dev/null
[[ ! -e "$tmp/releases/$sha" ]]
env PATH="$tmp/bin:$PATH" GIT_FAKE_SHA="$sha" PM2_BIN="$tmp/bin/pm2" MULTICA_RELEASE_ROOT="$tmp/releases" MULTICA_RECEIPT_ROOT="$tmp/receipts" "$root/ops/belt/deploy-release.sh" --apply "$sha"
[[ -f "$tmp/receipts/belt-$sha.json" ]] && node --input-type=module -e 'let a=(await import(process.argv[1])).default.apps;process.exit(a.length===5&&a.every(x=>x.script.startsWith(process.argv[2]))?0:1)' "file://$tmp/releases/$sha/ops/belt/ecosystem.gsp-belt.config.js" "$tmp/releases/$sha"
[[ "$(tail -n 1 "$tmp/pm2.log")" == '0 0' ]]
env PATH="$tmp/bin:$PATH" GIT_FAKE_SHA="$sha" PM2_BIN="$tmp/bin/pm2" MULTICA_RELEASE_ROOT="$tmp/releases" MULTICA_RECEIPT_ROOT="$tmp/receipts" "$root/ops/belt/deploy-release.sh" --rollback "$sha" --include-worker --skip-cicd-worker
[[ "$(tail -n 1 "$tmp/pm2.log")" == '1 1' ]]
set +e; env MULTICA_RELEASE_ROOT="$tmp/releases" "$root/ops/belt/deploy-release.sh" --preflight 0000000000000000000000000000000000000000 >/dev/null 2>&1; rc=$?; set -e; [[ $rc == 65 ]]
echo 'deploy release tests passed'
