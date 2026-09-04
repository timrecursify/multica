## NOC2 scratch cleanup

Install `multica-scratch.conf` from the immutable NOC2 artifact into
`/etc/tmpfiles.d/multica-scratch.conf`, then apply it:

```sh
sudo install -m 0644 multica-scratch.conf /etc/tmpfiles.d/multica-scratch.conf
sudo systemd-tmpfiles --create --clean
```

Only the belt's top-level scratch directories are covered. Entries older than
two hours are reclaimed; the normal `/tmp` 30-day policy remains unchanged.

## Backup lane age metrics

`backup-lanes.conf`, `gsp-backup-age-emitter.sh`, and
`gsp-backup-age-emitter.service` are owned by this repository. From a clean
checkout, run the single supported deployment command as root:

```sh
sudo ./backup-lanes-deploy.sh
sudo systemctl start gsp-backup-age-emitter.service
```

The installer owns `/etc/gsp/backup-lanes.conf` (0640),
`/usr/local/bin/gsp-backup-age-emitter.sh` (0755), and the systemd unit (0644).
Lane definitions use `LANE_<name>_REPOSITORY` and optional `LANE_<name>_ENV_FILE`;
the latter is the only place credentials may be supplied. To override safely,
copy the config to a root-owned temporary file, review it, atomically replace
`/etc/gsp/backup-lanes.conf`, then start the unit. Roll back by reinstalling
the file from the previous repository commit and starting the unit again.

The emitter always exits zero. It emits one `backup_lane_age_seconds` and one
`backup_lane_query_ok` row per configured lane; a failed query emits age `0`
and `backup_lane_query_ok=0`. Repository selection is passed explicitly to the
query helper, and credentials are never logged.
