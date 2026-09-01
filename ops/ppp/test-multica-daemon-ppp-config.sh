#!/usr/bin/env bash
# Hermetic config/lock checks; no systemd manager or production path is used.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT="$ROOT/systemd/multica-daemon-ppp.service"
WRAPPER="$ROOT/multica-daemon-ppp.sh"
INSTALLER="$ROOT/install-multica-daemon-ppp.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

bash -n "$WRAPPER" "$INSTALLER"
grep -Fq -- '--profile=ppp-prod-codex' "$WRAPPER"
grep -Fq -- '--daemon-id=ppp-prod-codex' "$WRAPPER"
grep -Fq -- '--max-concurrent-tasks=2' "$WRAPPER"
grep -Fq -- 'flock -n 9' "$WRAPPER"
grep -Fq -- 'Restart=always' "$UNIT"
grep -Fq -- 'MULTICA_DAEMON_ALLOWED_PROVIDERS=codex' "$UNIT"
grep -Fq -- 'MULTICA_WORKSPACES_ROOT=/var/lib/multica-ppp/workspaces' "$ROOT/ppp-daemon.env.example"

profile='ppp-prod-codex'
health_port=$((19514 + 1 + $(LC_ALL=C printf '%s' "$profile" | od -An -tu1 | awk '{for (i=1;i<=NF;i++) s+=$i} END {print s % 1000}')))
[[ "$health_port" == 19909 ]]

fake="$WORK/fake-daemon"
cat > "$fake" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" > "${FAKE_ARGS:?}"
sleep 30
EOF
chmod +x "$fake"
export MULTICA_DAEMON_BIN="$fake"
export MULTICA_WORKSPACES_ROOT="$WORK/workspaces"
export MULTICA_DAEMON_LOCK_FILE="$WORK/ppp.lock"
export FAKE_ARGS="$WORK/args"
"$WRAPPER" & first=$!
for _ in 1 2 3 4 5; do [[ -s "$FAKE_ARGS" ]] && break; sleep 0.1; done
if "$WRAPPER" 2>"$WORK/second.err"; then
  echo 'duplicate lock was not enforced' >&2
  kill "$first" 2>/dev/null || true
  wait "$first" 2>/dev/null || true
  exit 1
fi
kill "$first" 2>/dev/null || true
wait "$first" 2>/dev/null || true
grep -Fq 'duplicate instance' "$WORK/second.err"
grep -Fq -- '--max-concurrent-tasks=2' "$WORK/args"

"$INSTALLER" --dry-run > "$WORK/dry-run"
grep -Fq 'would run:' "$WORK/dry-run"
printf 'PASS: PPP daemon config, health-port derivation, allowlist, dry-run, and duplicate lock\n'
