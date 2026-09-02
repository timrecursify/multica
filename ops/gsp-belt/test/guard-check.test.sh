#!/bin/bash
# Tests for scripts/belt-guard-check.sh against a temp git checkout.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GUARD="$ROOT/scripts/belt-guard-check.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

export DATABASE_URL="postgres://test/multica"
export RELAY_AGENT_SECRET="test-relay"
export GSP_WORKSPACE_ID="00000000-0000-4000-8000-000000000001"
export MULTICA_WORKSPACE_ID="00000000-0000-4000-8000-000000000001"

HOST="$WORK/host"
mkdir -p "$HOST"
mkdir -p "$HOST/ops" && cp -R "$ROOT" "$HOST/ops/gsp-belt"
git -C "$HOST" init -q
git -C "$HOST" add -A
git -C "$HOST" -c user.email=t@t -c user.name=t commit -qm base

echo "== guard against clean checkout: expect PASS =="
# shellcheck disable=SC2034
if "$GUARD" --checkout "$HOST"; then echo "PASS: clean guard exits 0"; else echo "FAIL: clean guard exit != 0"; exit 1; fi

echo "== guard flags embedded raw secret in tracked config =="
SECRET_OUT="$WORK/secret.out"
# A tracked file with a real API-key shape must trip the secret guard.
mkdir -p "$HOST/ops/gsp-belt/worker"
printf 'const API_KEY = sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;\n' > "$HOST/ops/gsp-belt/worker/bad.cjs"
set +e
"$GUARD" --checkout "$HOST" > "$SECRET_OUT" 2>&1
rc=$?
set -e
if [[ $rc -ne 0 ]] && grep -q "guard\[secret-embedded\]" "$SECRET_OUT"; then
  echo "PASS: embedded-secret guard flags a raw key"
else
  echo "FAIL: embedded-secret guard did not flag"; cat "$SECRET_OUT"; exit 1
fi

echo "== guard flags unmanaged home-directory script reference =="
UNMAN_OUT="$WORK/un.out"
rm -f "$HOST/ops/gsp-belt/worker/bad.cjs"
printf '#!/bin/bash\nexec /home/newadmin/gsp-multica/multica-bridge.cjs\n' > "$HOST/ops/gsp-belt/fleet/bad.sh"
set +e
"$GUARD" --checkout "$HOST" > "$UNMAN_OUT" 2>&1
rc=$?
set -e
if [[ $rc -ne 0 ]]; then
  echo "PASS: unmanaged-script guard flags home-dir exec"
else
  echo "FAIL: unmanaged-script guard missed home-dir exec"; cat "$UNMAN_OUT"; exit 1
fi

echo ""
echo "ALL GUARD-CHECK TESTS PASSED"
exit 0
