## Stale relay reconciliation

Operators can trigger a workspace-scoped retry with `POST /api/relay/reconcile/stale` (operator authentication required):

```json
{"workspace_id":"<workspace UUID>"}
```

Issues in `In Review` or `CI/CD & Deploy` whose `updated_at` is at least 60 minutes old are selected when they have no completed `relay_run_log` successor. Each issue is retried through the transactional `/api/relay/advance-stage` path toward `Done`; its row lock and pending-task uniqueness make repeated triggers idempotent. The response reports `scanned`, `recovered`, `rejected`, and `failed` counters. Illegal edges or unavailable owners leave the issue unchanged and append a failed audit row. A scan with no eligible rows is a successful no-op.
