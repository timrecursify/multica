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
echo PASS
