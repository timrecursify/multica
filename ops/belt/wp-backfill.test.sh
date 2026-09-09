#!/usr/bin/env bash
set -Eeuo pipefail
root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/etc"
secret='fixture-secret-value'
cat >"$tmp/etc/relay.env" <<EOF
DATABASE_URL=postgres://fixture:${secret}@db/app
UNRELATED_SECRET=${secret}
EOF
cat >"$tmp/bin/node" <<'EOF'
#!/usr/bin/env bash
[[ "${DATABASE_URL-}" == postgres://fixture:*@db/app ]]
printf 'child received mode=%s database-config=yes\n' "$2"
EOF
chmod 0755 "$tmp/bin/node"
# Test a fixture copy while separately asserting the production path is fixed.
sed -e "s#/etc/gsp/multica/multica-relay-advance.env#$tmp/etc/relay.env#" \
    -e "s#/usr/bin/node#$tmp/bin/node#" "$root_dir/wp-backfill.sh" >"$tmp/helper"
chmod 0755 "$tmp/helper"
out="$("$tmp/helper" --dry-run --batch-size=2)"
[[ "$out" == *'child received mode=--dry-run database-config=yes'* ]]
[[ "$out" != *"$secret"* ]]
if "$tmp/helper" --unknown >/dev/null 2>&1; then exit 1; fi
if "$tmp/helper" --dry-run --retry-runtime-evidence >/dev/null 2>&1; then exit 1; fi
grep -Fq "readonly env_file='/etc/gsp/multica/multica-relay-advance.env'" "$root_dir/wp-backfill.sh"
grep -Fq 'wp-backfill' "$root_dir/belt-manifest.sh"
echo 'wp-backfill contract tests passed'
