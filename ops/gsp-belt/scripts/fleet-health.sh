#!/usr/bin/env bash
set -Eeuo pipefail
usage() { echo "usage: $0 [--port N] [--max-age SEC] [--tick-max-age SEC] [--repair]" >&2; exit 2; }
requested_daemon_port="${MULTICA_DAEMON_PORT-}"
requested_health_port="${MULTICA_HEALTH_PORT-}"
if [[ -n "$requested_daemon_port" && -n "$requested_health_port" && "$requested_daemon_port" != "$requested_health_port" ]]; then
  echo "fleet-health: MULTICA_DAEMON_PORT ($requested_daemon_port) disagrees with MULTICA_HEALTH_PORT ($requested_health_port)" >&2
  exit 2
fi
port="${requested_daemon_port:-${requested_health_port:-20464}}"; max_age="${MULTICA_HEARTBEAT_MAX_AGE_SECONDS:-90}"; tick_max_age="${MULTICA_TICK_MAX_AGE_SECONDS:-120}"; repair=0
while (($#)); do case "$1" in --port) port="${2:-}"; shift 2;; --max-age) max_age="${2:-}"; shift 2;; --tick-max-age) tick_max_age="${2:-}"; shift 2;; --repair) repair=1; shift;; -h|--help) usage;; *) usage;; esac; done
[[ "$port" =~ ^[0-9]+$ && "$max_age" =~ ^[0-9]+$ && "$tick_max_age" =~ ^[0-9]+$ ]] || usage
probe() { python3 - "$port" "$max_age" "$tick_max_age" <<'PY'
import json,sys,urllib.request
from datetime import datetime,timezone
p,m,tm=int(sys.argv[1]),int(sys.argv[2]),int(sys.argv[3])
try:
 with urllib.request.urlopen(f'http://127.0.0.1:{p}/health',timeout=3) as r: h=json.load(r)
except Exception as e: print(f'fleet-health: endpoint unavailable: {e}',file=sys.stderr); raise SystemExit(1)
def parse_stamp(name):
 stamp=h.get(name)
 if not isinstance(stamp,str) or not stamp: return None
 try: return (datetime.now(timezone.utc)-datetime.fromisoformat(stamp.replace('Z','+00:00'))).total_seconds()
 except (TypeError,ValueError): return None
age=parse_stamp('last_heartbeat_at')
reported_port=h.get('health_port')
if reported_port is not None and reported_port != p:
 print(f"fleet-health: endpoint reports health_port={reported_port}, expected {p}",file=sys.stderr); raise SystemExit(1)
print(f"fleet status={h.get('status','unknown')} pid={h.get('pid','unknown')} health_port={reported_port if reported_port is not None else p} heartbeat_age={age if age is not None else 'unknown'}s")
tick_age=parse_stamp('last_tick_completed_at')
print(f"fleet tick_count={h.get('tick_count','unknown')} tick_outcome={h.get('last_tick_outcome','unknown')} tick_age={tick_age if tick_age is not None else 'unknown'}s")
if h.get('status')!='running': print('fleet-health: daemon is not running',file=sys.stderr); raise SystemExit(1)
if age is None or age>m: print('fleet-health: stale heartbeat',file=sys.stderr)
if tick_age is None or tick_age>tm: print('fleet-health: wedged tick (heartbeat may still be fresh)',file=sys.stderr)
count=h.get('tick_count'); outcome=h.get('last_tick_outcome')
if not isinstance(count,int) or count<0 or not isinstance(outcome,str) or not outcome:
 print('fleet-health: malformed tick telemetry',file=sys.stderr)
 raise SystemExit(1)
if age is None or age>m or tick_age is None or tick_age>tm: raise SystemExit(1)
PY
}
if probe; then exit 0; fi
if (( repair )); then
  "${PM2:-pm2}" restart "${MULTICA_FLEET_PM2_APP:-gsp-multica-fleet}" >/dev/null
  for _ in {1..30}; do probe && exit 0; sleep 2; done
fi
echo 'fleet-health: unhealthy daemon (stopped, not ready, or stale heartbeat)' >&2; exit 1
