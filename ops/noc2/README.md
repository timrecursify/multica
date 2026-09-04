## NOC2 scratch cleanup

Install `multica-scratch.conf` from the immutable NOC2 artifact into
`/etc/tmpfiles.d/multica-scratch.conf`, then apply it:

```sh
sudo install -m 0644 multica-scratch.conf /etc/tmpfiles.d/multica-scratch.conf
sudo systemd-tmpfiles --create --clean
```

Only the belt's top-level scratch directories are covered. Entries older than
two hours are reclaimed; the normal `/tmp` 30-day policy remains unchanged.
