#!/usr/bin/env bash
set -Eeuo pipefail
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
install -d -m 0755 /etc/gsp /usr/local/bin /etc/systemd/system
install -o root -g root -m 0640 "$root/backup-lanes.conf" /etc/gsp/backup-lanes.conf
install -o root -g root -m 0755 "$root/gsp-backup-age-emitter.sh" /usr/local/bin/gsp-backup-age-emitter.sh
install -o root -g root -m 0644 "$root/gsp-backup-age-emitter.service" /etc/systemd/system/gsp-backup-age-emitter.service
systemctl daemon-reload
echo 'Installed gsp backup lane assets. Override /etc/gsp/backup-lanes.conf, then run systemctl start gsp-backup-age-emitter.service.'
