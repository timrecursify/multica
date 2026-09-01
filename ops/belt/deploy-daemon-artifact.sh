#!/usr/bin/env bash
# Atomically install an exact-SHA daemon artifact and reload only its PM2 app.
# This command is an operator surface: --apply is required and it emits a
# receipt that binds the install, backup, binary checksum, and health result.
set -Eeuo pipefail

artifact_dir=""; expected_sha=""; apply=0
while (($#)); do
  case "$1" in
    --artifact-dir) artifact_dir="${2:-}"; shift 2 ;;
    --source-sha) expected_sha="${2:-}"; shift 2 ;;
    --apply) apply=1; shift ;;
    *) echo "usage: $0 --artifact-dir DIR --source-sha SHA --apply" >&2; exit 64 ;;
  esac
done
fail() { echo "daemon artifact deploy: $*" >&2; exit 78; }
[[ $apply == 1 && "$expected_sha" =~ ^[0-9a-f]{40}$ ]] || fail "--apply and a 40-character --source-sha are required"
[[ "$artifact_dir" = /* && -d "$artifact_dir" && ! -L "$artifact_dir" ]] || fail "artifact directory must be an absolute real directory"
manifest="$artifact_dir/daemon-artifact.env"; binary="$artifact_dir/multica-linux-amd64"
[[ -f "$manifest" && -f "$binary" && ! -L "$binary" && -x "$binary" ]] || fail "artifact manifest or executable is missing"
source "$manifest"
[[ "${SOURCE_SHA:-}" == "$expected_sha" && "${GOOS:-}" == linux && "${GOARCH:-}" == amd64 ]] || fail "artifact identity does not match requested source SHA"
[[ "$(sha256sum "$binary" | awk '{print $1}')" == "${BINARY_SHA256:-}" ]] || fail "artifact checksum mismatch"
"$binary" version --output json | grep -Fq "\"commit\": \"$expected_sha\"" || fail "artifact version does not carry requested source SHA"

target="${MULTICA_DAEMON_TARGET:-/home/newadmin/multica-daemon/server}"
pm2_bin="${PM2_BIN:-pm2}"; ps_bin="${PS_BIN:-ps}"; app="${MULTICA_DAEMON_PM2_APP:-gsp-multica-worker}"
[[ "$target" = /* && -f "$target" && ! -L "$target" ]] || fail "daemon target must be an existing regular absolute file"
target_dir="$(dirname "$target")"; stamp="$(date -u +%Y%m%dT%H%M%SZ)"; backup="${target}.bak-${stamp}"
before_argv="$($ps_bin -eo args= | awk '$0 ~ /server daemon start/ {print; exit}')"
[[ "$before_argv" == *'--max-concurrent-tasks'* ]] || fail "running daemon argv lacks --max-concurrent-tasks"
tmp="$(mktemp "$target_dir/.server.${expected_sha}.XXXXXX")"
cleanup() { rm -f -- "$tmp"; }
rollback() { cp --preserve=mode -- "$backup" "$target"; "$pm2_bin" reload "$app" --update-env >/dev/null; cleanup; exit 1; }
trap cleanup EXIT
cp --preserve=mode -- "$target" "$backup"
cp --preserve=mode -- "$binary" "$tmp"; chmod 0755 -- "$tmp"; mv -f -- "$tmp" "$target"
if ! "$pm2_bin" reload "$app" --update-env >/dev/null; then rollback; fi
sleep 2
after_argv="$($ps_bin -eo args= | awk '$0 ~ /server daemon start/ {print; exit}')"
if [[ "$after_argv" != *'--max-concurrent-tasks'* ]] || ! "$target" version --output json | grep -Fq "\"commit\": \"$expected_sha\""; then rollback; fi
printf '{"source_sha":"%s","binary_sha256":"%s","backup":"%s","app":"%s","health":"ok"}\n' "$expected_sha" "$BINARY_SHA256" "$backup" "$app"
