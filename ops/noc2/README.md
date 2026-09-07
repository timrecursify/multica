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

For diagnosis, inspect the reason-labelled metric and the service journal:

```sh
curl -s http://127.0.0.1:9100/metrics | grep backup_lane_query_failure
sudo journalctl -u gsp-backup-age-emitter.service -n 50 --no-pager
```

The `reason` label is one of `missing_repo`, `authentication`,
`configuration`, `transport`, or `unknown`. Verify the corresponding
repository, credential env-file permissions, or network dependency without
printing the env file contents. After remediation, safely rerun the probe and
confirm the resulting metrics:

```sh
sudo systemctl start gsp-backup-age-emitter.service
curl -s http://127.0.0.1:9100/metrics | grep -E 'backup_lane_query_(ok|failure)'
```
