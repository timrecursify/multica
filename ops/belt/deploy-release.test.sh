#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"; tmp="$(mktemp -d)"; trap 'chmod -R u+w "$tmp" 2>/dev/null || true; rm -rf "$tmp"' EXIT
sha="$(git -C "$root" rev-parse HEAD)"; mkdir -p "$tmp/bin" "$tmp/releases" "$tmp/receipts"
mkdir -p "$tmp/fixture/dist"; printf 'module.exports = 1\n' > "$tmp/fixture/dist/cc-intercom.js"; printf 'token=private\n' > "$tmp/fixture/dist/service.secret"
chmod 700 "$tmp/fixture" "$tmp/fixture/dist" "$tmp/fixture/dist/cc-intercom.js"; chmod 600 "$tmp/fixture/dist/service.secret"
"$root/ops/belt/normalize-release-permissions.sh" "$tmp/fixture"
[[ "$(stat -c '%a' "$tmp/fixture/dist")" == 555 && "$(stat -c '%a' "$tmp/fixture/dist/cc-intercom.js")" == 544 ]]
[[ "$(stat -c '%a' "$tmp/fixture/dist/service.secret")" == 400 ]]
if [[ $(id -u) == 0 ]] && command -v runuser >/dev/null && id nobody >/dev/null 2>&1; then
  runuser -u nobody -- test -r "$tmp/fixture/dist/cc-intercom.js"
fi
node -e "require(process.argv[1])" "$tmp/fixture/dist/cc-intercom.js"
! find "$tmp/fixture" -type f -perm /222 -print -quit | grep -q .
cat >"$tmp/bin/go" <<'EOF'
#!/usr/bin/env bash
while [[ $# -gt 0 ]]; do [[ "$1" == -o ]] && { shift; out="$1"; }; shift || true; done
printf '#!/usr/bin/env bash\nprintf "{\\"commit\\": \\"%s\\"}" "${GIT_FAKE_SHA:-unknown}"\n' > "$out"; chmod +x "$out"
EOF
chmod +x "$tmp/bin/go"
cat >"$tmp/bin/pm2" <<'EOF'
#!/usr/bin/env bash
case "$1" in jlist) printf '[{"name":"gsp-multica-bridge","pm2_env":{"status":"online","pm_cwd":"%s"}},{"name":"multica-relay-advance","pm2_env":{"status":"online","pm_cwd":"%s","pm_exec_path":"%s/ops/gsp-belt/relay/multica-relay-advance-wrapper.sh"}},{"name":"gsp-multica-worker","pm2_env":{"status":"online","pm_cwd":"%s"}},{"name":"multica-cicd-worker","pm2_env":{"status":"online","pm_cwd":"%s"}},{"name":"multica-archiver","pm2_env":{"status":"online","pm_cwd":"%s"}}]' "$EXPECT_RELEASE" "$EXPECT_RELEASE" "$EXPECT_RELEASE" "$EXPECT_RELEASE" "$EXPECT_RELEASE" "$EXPECT_RELEASE";; startOrReload) printf '%s %s\n' "${MULTICA_INCLUDE_WORKER:-0}" "${MULTICA_SKIP_CICD_WORKER:-0}" >> "$PM2_LOG";; *) exit 0;; esac
EOF
chmod +x "$tmp/bin/pm2"; export EXPECT_RELEASE="$tmp/releases/$sha" PM2_LOG="$tmp/pm2.log"
env PM2_BIN="$tmp/bin/pm2" MULTICA_RELEASE_ROOT="$tmp/releases" MULTICA_RECEIPT_ROOT="$tmp/receipts" "$root/ops/belt/deploy-release.sh" --preflight "$sha" >/dev/null
[[ ! -e "$tmp/releases/$sha" ]]
env PATH="$tmp/bin:$PATH" GIT_FAKE_SHA="$sha" PM2_BIN="$tmp/bin/pm2" MULTICA_RELEASE_ROOT="$tmp/releases" MULTICA_RECEIPT_ROOT="$tmp/receipts" "$root/ops/belt/deploy-release.sh" --apply "$sha"
[[ -f "$tmp/receipts/belt-$sha.json" ]] && node -e 'const fs=require("fs");const s=fs.readFileSync(process.argv[1],"utf8");process.exit((s.match(/script:/g)||[]).length===6 && s.includes("multica-relay-advance-wrapper.sh") ? 0 : 1)' "$tmp/releases/$sha/ops/belt/ecosystem.gsp-belt.config.js"
[[ "$(tail -n 1 "$tmp/pm2.log")" == '0 0' ]]
env PATH="$tmp/bin:$PATH" GIT_FAKE_SHA="$sha" PM2_BIN="$tmp/bin/pm2" MULTICA_RELEASE_ROOT="$tmp/releases" MULTICA_RECEIPT_ROOT="$tmp/receipts" "$root/ops/belt/deploy-release.sh" --rollback "$sha" --include-worker --skip-cicd-worker
[[ "$(tail -n 1 "$tmp/pm2.log")" == '1 1' ]]
set +e; env MULTICA_RELEASE_ROOT="$tmp/releases" "$root/ops/belt/deploy-release.sh" --preflight 0000000000000000000000000000000000000000 >/dev/null 2>&1; rc=$?; set -e; [[ $rc == 65 ]]
echo 'deploy release tests passed'
