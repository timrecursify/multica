#!/usr/bin/env bash
set -Eeuo pipefail
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
grep -q '^pgbackrest-noc2|pgbackrest|' "$root/backup-lanes.conf"
grep -q '^restic-b2|restic|' "$root/backup-lanes.conf"
grep -q '^multica-v2-dump|restic|' "$root/backup-lanes.conf"
grep -q '^full-server-gdrive|restic|' "$root/backup-lanes.conf"
grep -q '^pi-fleet-copy|restic|' "$root/backup-lanes.conf"
grep -q '^full-server-b2|restic|' "$root/backup-lanes.conf"
grep -q 'backup_last_success_timestamp_seconds' "$root/gsp-backup-age-emitter.sh"
grep -q 'backup_emitter_errors_total' "$root/gsp-backup-age-emitter.sh"
grep -q 'runuser -u postgres' "$root/gsp-backup-age-emitter.sh"
grep -q 'Environment=BACKUP_BOX=noc2' "$root/gsp-backup-age-emitter.service"
grep -q 'OnCalendar=hourly' "$root/gsp-backup-age-emitter.timer"
grep -q 'OnFailure=gsp-unit-alert@%n.service' "$root/gsp-backup-age-emitter.service.d/onfailure-sink.conf"

# Exercise the emitter with a password-file configuration and one failed
# query. This stays offline and deterministic: fake restic models the command
# JSON contract without contacting a backup provider.
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture/bin" "$fixture/out" "$fixture/state"
printf 'fixture-password\n' >"$fixture/password"
printf 'RESTIC_PASSWORD_FILE=%s\n' "$fixture/password" >"$fixture/env"
cat >"$fixture/bin/restic" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
tag=''
while (($#)); do
  if [[ "$1" == --tag ]]; then tag="$2"; shift 2; else shift; fi
done
if [[ "$tag" == broken ]]; then
  exit 17
fi
printf '[{"time":"2026-09-05T05:31:49Z"}]\n'
EOF
chmod 0755 "$fixture/bin/restic"
printf 'healthy|restic|fixture:healthy|%s|tag=healthy\nunreadable|restic|fixture:broken|%s|tag=broken\n' "$fixture/env" "$fixture/env" >"$fixture/lanes.conf"
if PATH="$fixture/bin:$PATH" \
  BACKUP_BOX=fixture BACKUP_LANES_CONF="$fixture/lanes.conf" \
  OUT_DIR="$fixture/out" STATE_DIR="$fixture/state" \
  "$root/gsp-backup-age-emitter.sh"; then
  echo 'expected an unreadable lane to fail the emitter' >&2
  exit 1
fi
grep -q 'backup_last_success_timestamp_seconds{box="fixture",lane="healthy"' "$fixture/out/gsp_backup_age.prom"
grep -q 'backup_lane_query_ok{box="fixture",lane="healthy"} 1' "$fixture/out/gsp_backup_age.prom"
grep -q 'backup_lane_query_ok{box="fixture",lane="unreadable"} 0' "$fixture/out/gsp_backup_age.prom"
echo PASS
