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

`backup-lanes.conf`, `gsp-backup-age-emitter.sh`, the service and timer units,
and the service drop-in are owned by this repository. From a clean
checkout, run the single supported deployment command as root:

```sh
sudo ./backup-lanes-deploy.sh
sudo systemctl start gsp-backup-age-emitter.service
```

The installer owns the exact live assets: `/etc/gsp/backup-lanes.conf` (0640),
`/usr/local/bin/gsp-backup-age-emitter.sh` (0755), and all systemd files (0644).
The pipe-delimited lane table keeps repository URLs and env-file references;
credentials remain in the referenced 0600 files. The emitter derives success
timestamps from restic snapshots or pgBackRest manifests and writes atomically
to the node-exporter textfile directory. A failed lane emits
`backup_lane_query_ok=0` and the process exits nonzero so systemd records the
failure while preserving the other lanes' metrics.
