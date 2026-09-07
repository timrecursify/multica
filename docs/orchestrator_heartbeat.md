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

The rules distinguish three failure modes. `OrchestratorHeartbeatMissing` fires
after five minutes when the gauge is absent and includes `service` and
`expected_instance` identity labels. `OrchestratorHeartbeatStale` fires when
the gauge value is older than the configured stale threshold (150 seconds by
default). `OrchestratorHeartbeatWriteFailing` fires when the independent
`multica_orchestrator_heartbeat_write_failures_total` counter increases; this
identifies an exporter/write-path failure rather than a stopped process.
