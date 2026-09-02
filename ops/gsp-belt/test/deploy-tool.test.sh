#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
output="$(mktemp)"
trap 'rm -f "$output"' EXIT

if bash "$root/deploy/gsp-belt-deploy.sh" --ref arbitrary >"$output" 2>&1; then
  echo 'FAIL: legacy deploy unexpectedly succeeded' >&2
  exit 1
fi
grep -qx 'Refusing legacy GSP belt deployment. Use ops/belt/deploy.sh; it fetches origin/main and writes a deployment receipt.' "$output"
echo 'legacy deploy refusal test passed'
