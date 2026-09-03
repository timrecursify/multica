#!/usr/bin/env bash
# Bounded, read-only diagnostics and optional single-process recovery for the bridge.
set -Eeuo pipefail

usage() { echo "usage: $0 --release DIR [--baseline-unstable-restarts N] [--repair]" >&2; exit 2; }
release= baseline= repair=0
while (($#)); do
  case "$1" in
    --release) release="${2:-}"; shift 2;;
    --baseline-unstable-restarts) baseline="${2:-}"; shift 2;;
    --repair) repair=1; shift;;
    -h|--help) usage;; *) usage;;
  esac
done
[[ -n "$release" ]] || usage
metadata="$release/.gsp-belt-release.json"
[[ -r "$metadata" ]] || { echo "bridge-health: release metadata missing: $metadata" >&2; exit 1; }
commit_sha="$(python3 - "$metadata" <<'PY'
import json,sys
try: print(json.load(open(sys.argv[1]))['commit_sha'])
except Exception: raise SystemExit(1)
PY
)" || { echo 'bridge-health: invalid release metadata' >&2; exit 1; }
[[ "$commit_sha" =~ ^[0-9a-f]{40}$ ]] || { echo 'bridge-health: invalid release commit SHA' >&2; exit 1; }
pm2_bin="${PM2:-pm2}"
snapshot="$(mktemp "${TMPDIR:-/tmp}/gsp-bridge-health.XXXXXX")"; trap 'rm -f -- "$snapshot"' EXIT

inspect() {
  "$pm2_bin" jlist >"$snapshot" || { echo 'bridge-health: pm2 jlist failed' >&2; return 1; }
  python3 - "$snapshot" "$release" "${baseline:-}" "$commit_sha" <<'PY'
import json,sys
rows=json.load(open(sys.argv[1])); release=sys.argv[2]; baseline=sys.argv[3]; commit=sys.argv[4]
p=next((x for x in rows if x.get('name')=='gsp-multica-bridge'),None)
if not p: print('bridge-health: gsp-multica-bridge missing', file=sys.stderr); raise SystemExit(1)
e=p.get('pm2_env',{}); status=e.get('status','missing'); restarts=e.get('unstable_restarts',0)
path=e.get('pm_exec_path',''); restart_time=e.get('restart_time',''); exit_code=e.get('exit_code',''); signal=e.get('exit_signal','')
print(f'bridge status={status} unstable_restarts={restarts} restart_time={restart_time} pm_exec_path={path} release_sha={commit}')
print(f'bridge exit_code={exit_code} exit_signal={signal}')
ok=status=='online' and path.startswith(release+'/ops/belt/')
if baseline:
  try: ok = ok and int(restarts) <= int(baseline)
  except ValueError: ok=False
if not ok:
  print('bridge-health: unhealthy bridge (offline, wrong release, or unstable restart increase)', file=sys.stderr)
  raise SystemExit(1)
PY
}

if inspect; then
  echo "bridge release commit = $commit_sha"
  exit 0
fi
if (( repair )); then
  echo 'bridge-health: attempting one restart of gsp-multica-bridge' >&2
  "$pm2_bin" restart gsp-multica-bridge >/dev/null 2>&1 || { echo 'bridge-health: restart command failed' >&2; exit 1; }
  if inspect; then echo "bridge release commit = $commit_sha"; exit 0; fi
fi
# Keep failure output actionable while avoiding environment/secrets.
python3 - "$snapshot" <<'PY'
import json,sys,os
rows=json.load(open(sys.argv[1])); p=next((x for x in rows if x.get('name')=='gsp-multica-bridge'),{})
e=p.get('pm2_env',{}); path=e.get('pm_err_log_path')
print(f"bridge failure cause: exit_code={e.get('exit_code','')} exit_signal={e.get('exit_signal','')}", file=sys.stderr)
if path and os.path.isfile(path):
  lines=open(path,errors='replace').read().splitlines()[-20:]
  for line in lines:
    print(line.replace('MULTICA_','MULTICA_[REDACTED]'), file=sys.stderr)
PY
exit 1
