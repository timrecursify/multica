#!/bin/bash
# Tests for scripts/belt-guard-check.sh against a temp git checkout.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GUARD="$ROOT/scripts/belt-guard-check.sh"
FINGERPRINT="$ROOT/scripts/belt-fingerprint.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

export DATABASE_URL="postgres://test/multica"
export RELAY_AGENT_SECRET="test-relay"
export ARCHIVER_AGENT_SECRET="test-archiver"
export GSP_WORKSPACE_ID="00000000-0000-4000-8000-000000000001"
export MULTICA_WORKSPACE_ID="00000000-0000-4000-8000-000000000001"

HOST="$WORK/host"
mkdir -p "$HOST"
mkdir -p "$HOST/ops" && cp -R "$ROOT" "$HOST/ops/gsp-belt"
mkdir -p "$HOST/ops/belt" && cp -R "$(cd "$ROOT/../belt" && pwd)"/. "$HOST/ops/belt/"
# A clean checkout can be read-only. This is a disposable mutation fixture.
chmod -R u+w "$HOST/ops/gsp-belt"
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
rm -f "$HOST/ops/gsp-belt/worker/bad.cjs"

echo "== guard flags stale documented provenance checksum =="
PROVENANCE_OUT="$WORK/provenance.out"
sed -i 's/640fca26677251ecf1168dad16188747e3d56640f93fb5262eb0b636aef2da75/0000000000000000000000000000000000000000000000000000000000000000/' "$HOST/ops/gsp-belt/MANIFEST.md"
set +e
"$GUARD" --checkout "$HOST" > "$PROVENANCE_OUT" 2>&1
rc=$?
set -e
if [[ $rc -ne 0 ]] && grep -q "guard\[provenance\]" "$PROVENANCE_OUT"; then
  echo "PASS: provenance guard flags a stale documented checksum"
else
  echo "FAIL: provenance guard did not flag"; cat "$PROVENANCE_OUT"; exit 1
fi
# Restore a valid fixture before exercising the independent unmanaged-path case.
sed -i 's/0000000000000000000000000000000000000000000000000000000000000000/640fca26677251ecf1168dad16188747e3d56640f93fb5262eb0b636aef2da75/' "$HOST/ops/gsp-belt/MANIFEST.md"

echo "== guard flags unmanaged home-directory script reference =="
UNMAN_OUT="$WORK/un.out"
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
rm -f "$HOST/ops/gsp-belt/fleet/bad.sh"

echo "== guard/fingerprint cover parity and SQL manifest entries =="
RELEASE="$WORK/release"
mkdir -p "$RELEASE"
cp -R "$HOST/ops" "$RELEASE/"
if "$GUARD" --checkout "$HOST" --release "$RELEASE" >/dev/null && \
   "$FINGERPRINT" --checkout "$HOST" --release "$RELEASE" >/dev/null; then
  echo "PASS: byte-identical release passes guard and fingerprint"
else
  echo "FAIL: byte-identical release was rejected"; exit 1
fi

for missing in ops/belt/parity/multica-relay-advance-daemon.cjs ops/gsp-belt/relay/multica-relay-advance-wrapper.sh; do
  rm -f "$RELEASE/$missing"
  set +e
  "$GUARD" --checkout "$HOST" --release "$RELEASE" >"$WORK/missing.out" 2>&1
  rc=$?
  set -e
  if [[ $rc -eq 0 ]] || ! grep -q "deployed missing $missing" "$WORK/missing.out"; then
    echo "FAIL: missing $missing was not named"; cat "$WORK/missing.out"; exit 1
  fi
  cp "$HOST/$missing" "$RELEASE/$missing"
done
echo "PASS: missing parity/runtime files are rejected by path"

for drift in ops/belt/parity/multica-relay-advance-daemon.cjs ops/gsp-belt/relay/multica-relay-advance-wrapper.sh; do
  printf '\n# drift\n' >> "$RELEASE/$drift"
  set +e
  "$FINGERPRINT" --checkout "$HOST" --release "$RELEASE" >"$WORK/drift.out" 2>&1
  rc=$?
  set -e
  if [[ $rc -eq 0 ]] || ! grep -q "deployed differs from source: $drift" "$WORK/drift.out"; then
    echo "FAIL: drift $drift was not named"; cat "$WORK/drift.out"; exit 1
  fi
  cp "$HOST/$drift" "$RELEASE/$drift"
done
echo "PASS: parity/runtime drift is rejected by path"

echo ""
echo "ALL GUARD-CHECK TESTS PASSED"
exit 0
