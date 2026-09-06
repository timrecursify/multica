#!/bin/bash
# Unified backup-age emitter for the Prometheus node_exporter textfile collector.
#
# Every value is derived from the ARTIFACT — the restic snapshot or the
# pgBackRest manifest in the real repository — never from timer state, journal
# text, or a "script finished" wall clock. A lane that produced nothing reports
# nothing, so staleness rules can fire on the absence of success.
#
# Lane table: /etc/gsp/backup-lanes.conf (no credentials; paths and repo URLs
# only). Credentials stay in their existing 0600 env files and are sourced into
# a subshell that never echoes them.
#
# Metrics:
#   backup_last_success_timestamp_seconds{box,lane,repo}
#   backup_lane_query_ok{box,lane}
#   backup_emitter_last_run_timestamp_seconds{box}
#   backup_emitter_errors_total{box}
#   backup_emitter_duration_seconds{box}

set -uo pipefail

BOX="${BACKUP_BOX:-$(hostname -s)}"
CONF="${BACKUP_LANES_CONF:-/etc/gsp/backup-lanes.conf}"
OUT_DIR="${OUT_DIR:-/var/lib/prometheus/node-exporter}"
OUT_FILE="$OUT_DIR/gsp_backup_age.prom"
STATE_DIR="${STATE_DIR:-/var/lib/gsp-backup-emitter}"
ERR_FILE="$STATE_DIR/errors_total"
LANE_TIMEOUT="${LANE_TIMEOUT:-180}"
# Unowned rclone: probes corrupt the rclone config owner. See query_restic.
RCLONE_PROBE_USER="${RCLONE_PROBE_USER:-newadmin}"

mkdir -p "$STATE_DIR" "$STATE_DIR/restic-cache" 2>/dev/null
[[ -f "$ERR_FILE" ]] || echo 0 >"$ERR_FILE"

START_TS="$(date +%s.%N)"
TMP_FILE="$(mktemp -p "$OUT_DIR" gsp_backup_age.prom.XXXXXX 2>/dev/null || mktemp)"
BODY="$(mktemp)"
trap 'rm -f "$TMP_FILE" "$BODY" 2>/dev/null || true' EXIT

RUN_ERRORS=0

failure_reason() {
  case "$1" in
    10) echo missing_repo ;;
    11) echo authentication ;;
    91|92|93|94) echo configuration ;;
    *) echo transport ;;
  esac
}

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }

# Latest snapshot epoch across every entry restic returns. --latest 1 is
# per-path-group, so a plain "last element" read can pick an older group.
max_snapshot_epoch() {
  python3 -c '
import json, re, sys, datetime
try:
    arr = json.load(sys.stdin)
except Exception as e:
    sys.stderr.write("json error: %s\n" % e); print(0); sys.exit(0)
best = 0
for s in arr or []:
    t = s.get("time", "")
    if not t:
        continue
    t = re.sub(r"\.(\d{1,6})\d*", lambda m: "." + m.group(1), t)
    try:
        best = max(best, int(datetime.datetime.fromisoformat(t).timestamp()))
    except Exception:
        continue
print(best)
'
}

pgbackrest_stop_epoch() {
  python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception as e:
    sys.stderr.write("json error: %s\n" % e); print(0); sys.exit(0)
best = 0
for st in data or []:
    for b in st.get("backup") or []:
        ts = (b.get("timestamp") or {}).get("stop")
        if isinstance(ts, (int, float)):
            best = max(best, int(ts))
print(best)
'
}

# Runs entirely in a subshell: sourced secrets never reach the parent shell.
query_restic() {
  local repo="$1" envs="$2" tag="$3" b2alias="$4"
  (
    set -a
    local IFS=,
    for f in $envs; do
      [[ -n "$f" ]] || continue
      [[ -r "$f" ]] || { echo "ENVUNREADABLE $f" >&2; exit 91; }
      # shellcheck disable=SC1090
      . "$f"
    done
    set +a
    if [[ "$b2alias" == "1" ]]; then
      export AWS_ACCESS_KEY_ID="${B2_ACCOUNT_ID:-${AWS_ACCESS_KEY_ID:-}}"
      export AWS_SECRET_ACCESS_KEY="${B2_ACCOUNT_KEY:-${AWS_SECRET_ACCESS_KEY:-}}"
    fi
    export RESTIC_CACHE_DIR="$STATE_DIR/restic-cache"
    # Restic accepts a password directly, from a file, or from a command.
    # Reject the query only when none of those supported sources is configured.
    if [[ -z "${RESTIC_PASSWORD:-}" && -z "${RESTIC_PASSWORD_FILE:-}" && -z "${RESTIC_PASSWORD_COMMAND:-}" ]]; then
      echo "NOPASSWORD" >&2
      exit 92
    fi
    local args=(-r "$repo" snapshots --latest 1 --json)
    [[ -n "$tag" ]] && args+=(--tag "$tag")
    # An rclone: repo makes restic spawn rclone, and rclone REWRITES ITS OWN
    # CONFIG on OAuth token refresh. Probing such a repo as root leaves
    # ~newadmin/.config/rclone/rclone.conf owned root:newadmin mode 0600, which
    # silently kills backups-daily-gdrive.service (User=newadmin) on every later
    # run. Probe rclone repos as the config owner instead. See GSP-1939.
    # Detect the rclone route three ways, not one. The lane-table repo is the
    # usual signal, but RESTIC_REPOSITORY from the env file or an explicit
    # RCLONE_CONFIG reach rclone just as well. A single prefix test is the same
    # brittle string match that hid this bug in the first place.
    #
    # sftp: repos need the same drop for a different reason: restic shells out to
    # ssh, which reads the INVOKING user's ~/.ssh/config. The pi-mesh host block
    # and its cloudflared ProxyCommand live in ~newadmin/.ssh/config, so a root
    # probe cannot resolve the host at all.
    local needs_user_env=0
    [[ "$repo" == rclone:* ]] && needs_user_env=1
    [[ "${RESTIC_REPOSITORY:-}" == rclone:* ]] && needs_user_env=1
    [[ -n "${RCLONE_CONFIG:-}" ]] && needs_user_env=1
    [[ "$repo" == sftp:* ]] && needs_user_env=1
    [[ "${RESTIC_REPOSITORY:-}" == sftp:* ]] && needs_user_env=1
    if [[ "$needs_user_env" -eq 1 && "$(id -u)" -eq 0 ]]; then
      local rc_home rc_cache
      rc_home="$(getent passwd "$RCLONE_PROBE_USER" | cut -d: -f6)"
      if [[ -z "$rc_home" ]]; then
        echo "NORCLONEPROBEHOME $RCLONE_PROBE_USER" >&2; exit 93
      fi
      rc_cache="$STATE_DIR/restic-cache-$RCLONE_PROBE_USER"
      install -d -m 0700 -o "$RCLONE_PROBE_USER" -g "$RCLONE_PROBE_USER" "$rc_cache" || {
        echo "RCLONECACHEDIR $rc_cache" >&2; exit 94; }
      export HOME="$rc_home"
      export RESTIC_CACHE_DIR="$rc_cache"
      timeout "$LANE_TIMEOUT" runuser -u "$RCLONE_PROBE_USER" --preserve-environment -- \
        restic "${args[@]}" </dev/null
    else
      timeout "$LANE_TIMEOUT" restic "${args[@]}" </dev/null
    fi
  )
}

query_pgbackrest() {
  local stanza="$1" conf="$2" envs="$3"
  (
    set -a
    local IFS=,
    for f in $envs; do
      [[ -n "$f" ]] || continue
      [[ -r "$f" ]] || { echo "ENVUNREADABLE $f" >&2; exit 91; }
      # shellcheck disable=SC1090
      . "$f"
    done
    set +a
    local args=(--stanza="$stanza" info --output=json)
    [[ -n "$conf" ]] && args=(--config="$conf" "${args[@]}")
    timeout "$LANE_TIMEOUT" runuser -u postgres --preserve-environment -- \
      pgbackrest "${args[@]}" </dev/null
  )
}

opt_of() { # opt_of "<opts>" "<key>"
  printf '%s' "$1" | tr ',' '\n' | sed -n "s/^$2=//p" | head -1
}

if [[ ! -r "$CONF" ]]; then
  log "lane table unreadable: $CONF"
  RUN_ERRORS=$((RUN_ERRORS + 1))
fi

while IFS='|' read -r lane type repo envs opts; do
  [[ -z "${lane// }" ]] && continue
  [[ "${lane#\#}" != "$lane" ]] && continue
  lane="${lane// }"; type="${type// }"
  opts="${opts:-}"

  json=""; rc=0
  case "$type" in
    restic)
      json="$(query_restic "$repo" "$envs" "$(opt_of "$opts" tag)" "$(opt_of "$opts" b2alias)" 2>/dev/null)" || rc=$?
      epoch="$(printf '%s' "$json" | max_snapshot_epoch 2>/dev/null)"
      ;;
    pgbackrest)
      json="$(query_pgbackrest "$(opt_of "$opts" stanza)" "$(opt_of "$opts" conf)" "$envs" 2>/dev/null)" || rc=$?
      epoch="$(printf '%s' "$json" | pgbackrest_stop_epoch 2>/dev/null)"
      ;;
    *)
      log "lane $lane: unknown type '$type'"
      rc=90; epoch=0
      ;;
  esac

  [[ "${epoch:-0}" =~ ^[0-9]+$ ]] || epoch=0

  if [[ $rc -eq 0 && "$epoch" -gt 0 ]]; then
    printf 'backup_last_success_timestamp_seconds{box="%s",lane="%s",repo="%s"} %s\n' \
      "$BOX" "$lane" "$repo" "$epoch" >>"$BODY"
    printf 'backup_lane_query_ok{box="%s",lane="%s"} 1\n' "$BOX" "$lane" >>"$BODY"
  else
    reason="$(failure_reason "$rc")"
    log "lane $lane: query failed (reason=$reason)"
    RUN_ERRORS=$((RUN_ERRORS + 1))
    printf 'backup_lane_query_ok{box="%s",lane="%s"} 0\n' "$BOX" "$lane" >>"$BODY"
    printf 'backup_lane_query_failure{box="%s",lane="%s",reason="%s"} 1\n' "$BOX" "$lane" "$reason" >>"$BODY"
  fi
done < <(cat "$CONF" 2>/dev/null)

TOTAL="$(cat "$ERR_FILE" 2>/dev/null)"
[[ "$TOTAL" =~ ^[0-9]+$ ]] || TOTAL=0
TOTAL=$((TOTAL + RUN_ERRORS))
echo "$TOTAL" >"$ERR_FILE"

DURATION="$(awk -v s="$START_TS" -v e="$(date +%s.%N)" 'BEGIN{printf "%.3f", e-s}')"

{
  echo '# HELP backup_last_success_timestamp_seconds Unix epoch of the newest artifact in the backup repository for this lane.'
  echo '# TYPE backup_last_success_timestamp_seconds gauge'
  grep '^backup_last_success_timestamp_seconds' "$BODY" 2>/dev/null
  echo '# HELP backup_lane_query_ok Whether the emitter could read this lane repository (1=yes, 0=no).'
  echo '# TYPE backup_lane_query_ok gauge'
  grep '^backup_lane_query_ok' "$BODY" 2>/dev/null
  echo '# HELP backup_lane_query_failure Reason a lane repository query failed (1 when failed).'
  echo '# TYPE backup_lane_query_failure gauge'
  grep '^backup_lane_query_failure' "$BODY" 2>/dev/null
  echo '# HELP backup_emitter_last_run_timestamp_seconds Unix epoch the emitter last completed.'
  echo '# TYPE backup_emitter_last_run_timestamp_seconds gauge'
  printf 'backup_emitter_last_run_timestamp_seconds{box="%s"} %s\n' "$BOX" "$(date +%s)"
  echo '# HELP backup_emitter_errors_total Cumulative lane query failures since state was created.'
  echo '# TYPE backup_emitter_errors_total counter'
  printf 'backup_emitter_errors_total{box="%s"} %s\n' "$BOX" "$TOTAL"
  echo '# HELP backup_emitter_duration_seconds Wall-clock duration of the last emitter run.'
  echo '# TYPE backup_emitter_duration_seconds gauge'
  printf 'backup_emitter_duration_seconds{box="%s"} %s\n' "$BOX" "$DURATION"
} >"$TMP_FILE"

install -m 644 "$TMP_FILE" "$OUT_FILE"

[[ $RUN_ERRORS -eq 0 ]] || exit 1
exit 0
