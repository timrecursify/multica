## Orchestrator heartbeat metric

When `METRICS_ADDR` is configured, the server exposes the unlabeled
`multica_orchestrator_heartbeat_timestamp_seconds` gauge. Its value is the
Unix timestamp of the most recent daemon heartbeat that was processed
successfully; failed requests do not advance it.

Scrape the configured metrics listener from Prometheus, for example:

```yaml
scrape_configs:
  - job_name: multica
    static_configs:
      - targets: ["multica:9090"] # match METRICS_ADDR
```

The `OrchestratorHeartbeatMissing` alert should fire when the gauge is absent
or older than the expected heartbeat interval (with a startup grace period).
