#!/usr/bin/env bash
set -Eeuo pipefail
root="$(cd -- "$(dirname "$0")/.." && pwd)"; tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
cat > "$tmp/server.py" <<'PY'
from http.server import BaseHTTPRequestHandler,HTTPServer
import json,sys
class H(BaseHTTPRequestHandler):
 def do_GET(self): self.send_response(200); self.send_header('Content-Type','application/json'); self.end_headers(); self.wfile.write(json.dumps(json.load(open(sys.argv[1]))).encode())
 def log_message(self,*a): pass
HTTPServer(('127.0.0.1',int(sys.argv[2])),H).serve_forever()
PY
now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; printf '{"status":"running","pid":1,"health_port":29381,"last_heartbeat_at":"%s","last_tick_completed_at":"%s","tick_count":1,"last_tick_outcome":"success"}\n' "$now" "$now" > "$tmp/health.json"
python3 "$tmp/server.py" "$tmp/health.json" 29381 & server_pid=$!; trap 'kill "$server_pid" 2>/dev/null || true; rm -rf "$tmp"' EXIT
"$root/scripts/fleet-health.sh" --port 29381 --max-age 90 >/dev/null
if MULTICA_DAEMON_PORT=20464 MULTICA_HEALTH_PORT=20463 "$root/scripts/fleet-health.sh" >/dev/null 2>&1; then echo port mismatch accepted >&2; exit 1; fi
printf '{"status":"running","pid":1,"last_heartbeat_at":"2020-01-01T00:00:00Z","last_tick_completed_at":"%s","tick_count":1,"last_tick_outcome":"success"}\n' "$now" > "$tmp/health.json"
if "$root/scripts/fleet-health.sh" --port 29381 --max-age 90 >/dev/null 2>&1; then echo stale heartbeat accepted >&2; exit 1; fi
printf '{"status":"running","pid":1,"last_heartbeat_at":"%s","last_tick_completed_at":"2020-01-01T00:00:00Z","tick_count":1,"last_tick_outcome":"success"}\n' "$now" > "$tmp/health.json"
if "$root/scripts/fleet-health.sh" --port 29381 --max-age 90 --tick-max-age 120 >/dev/null 2>&1; then echo wedged tick accepted >&2; exit 1; fi
printf '{"status":"stopped","pid":1,"last_heartbeat_at":"%s","last_tick_completed_at":"%s","tick_count":1,"last_tick_outcome":"success"}\n' "$now" "$now" > "$tmp/health.json"
if "$root/scripts/fleet-health.sh" --port 29381 >/dev/null 2>&1; then echo stopped daemon accepted >&2; exit 1; fi
printf '{"status":"running","pid":1,"last_heartbeat_at":"%s"}\n' "$now" > "$tmp/health.json"
if "$root/scripts/fleet-health.sh" --port 29381 >/dev/null 2>&1; then echo missing telemetry accepted >&2; exit 1; fi
echo 'fleet health regression passed'
