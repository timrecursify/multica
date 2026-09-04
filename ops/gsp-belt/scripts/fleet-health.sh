#!/usr/bin/env bash
set -Eeuo pipefail
usage() { echo "usage: $0 [--port N] [--max-age SEC] [--repair]" >&2; exit 2; }
port="${MULTICA_HEALTH_PORT:-20463}"; max_age="${MULTICA_HEARTBEAT_MAX_AGE_SECONDS:-90}"; repair=0
while (($#)); do case "$1" in --port) port="${2:-}"; shift 2;; --max-age) max_age="${2:-}"; shift 2;; --repair) repair=1; shift;; -h|--help) usage;; *) usage;; esac; done
[[ "$port" =~ ^[0-9]+$ && "$max_age" =~ ^[0-9]+$ ]] || usage
probe() { python3 - "$port" "$max_age" <<'PY'
import json,sys,urllib.request
from datetime import datetime,timezone
p,m=int(sys.argv[1]),int(sys.argv[2])
try:
 with urllib.request.urlopen(f'http://127.0.0.1:{p}/health',timeout=3) as r: h=json.load(r)
except Exception as e: print(f'fleet-health: endpoint unavailable: {e}',file=sys.stderr); raise SystemExit(1)
age=None; stamp=h.get('last_heartbeat_at')
if stamp:
 try: age=(datetime.now(timezone.utc)-datetime.fromisoformat(stamp.replace('Z','+00:00'))).total_seconds()
 except ValueError: pass
print(f"fleet status={h.get('status','unknown')} pid={h.get('pid','unknown')} heartbeat_age={age if age is not None else 'unknown'}s")
if h.get('status')!='running' or age is None or age>m: raise SystemExit(1)
PY
}
if probe; then exit 0; fi
if (( repair )); then
  "${PM2:-pm2}" restart gsp-multica-worker >/dev/null
  for _ in {1..30}; do probe && exit 0; sleep 2; done
fi
echo 'fleet-health: unhealthy daemon (stopped, not ready, or stale heartbeat)' >&2; exit 1
