# Relay issue-stage advancement API

The Multica server provides a product-native service for advancing an issue's
stage and enqueueing its successor agent task in one database transaction. It is
the upstream replacement for the host-local `multica-bridge.cjs` `POST
/relay/advance` that the GSP belt previously relied on, and it lives inside the
product so an upgrade always knows about `relay_stage_config` and `relay_run_log`.

## Why a distinct route

The product already exposed `POST /api/relay/advance`, but that route performs
task-to-daemon lane routing (it only updates `agent_task_queue.daemon_id` and
**never** touches board/issue state — see `daemon.go`'s `RelayAdvance`). Its
contract is preserved unchanged. The issue-stage advancement service is a
separate operation with its own semantics, so it is mounted on its own route
rather than silently overloading the existing one.

## Endpoint

`POST /api/relay/advance-stage`

Request body:

```json
{
  "issue_id": "uuid",
  "to_stage": "In Review"
}
```

`to_stage` is matched exactly against `relay_stage_config` edge columns. No
canonicalization is applied: the relay passes the literal target through, and
callers are responsible for the status contract (the same behavior the bridge
implemented).

### Authorization

The route is mounted **outside** the user auth group and is guarded by the
same shared service bearer as the operator repair API:

- Environment: `MULTICA_OPERATOR_SECRET`
- Header: `Authorization: Bearer <secret>`

When the secret is unset the middleware rejects every request with `503` so an
unconfigured deployment never silently exposes the surface. The GSP belt and the
PPP MCP gateway already hold this value, so no new credential distribution is
required to cut over.

## Behavior

The handler opens one database transaction and:

1. **Row-locks** the target issue (`FOR UPDATE`) so concurrent or repeated
   relay delivery serializes on the issue row.
2. Resolves the requested edge from `relay_stage_config`, preferring the
   workspace-scoped row (`workspace_id = issue.workspace_id`) and falling back
   to the global default row set (`workspace_id IS NULL`).
3. Rejects:
   - a `to_stage` that is not a configured relay stage → `400`
   - an edge that is not a legal successor (`next_stage` / `alt_next_stages`)
     → `409`
   - a missing issue → `404`
   - a stage owner that is **archived** → `409`
   - a stage owner with **no online runtime** → `409`
4. Updates `issue.status` and inserts the successor `agent_task_queue` in the
   same transaction. The task insert uses `ON CONFLICT DO NOTHING`, so a
   duplicate delivery commits the status but does **not** double-enqueue (the
   `idx_one_pending_task_per_issue_agent_v2` unique index is the constraint
   backing idempotency).
5. Writes a `relay_run_log` row when a successor task was created.
6. Publishes an `issue:updated` realtime event with `relay: true`.

Because the issue update and task insert share one transaction, an enqueue
failure rolls back the issue update (no stage moved without its successor).

### Responses

Success (status `200`):

```json
{ "success": true, "issue": { "id": "...", "status": "Queue" }, "task_id": "...", "relay_log_id": 42 }
```

Already-applied (status `200`, `transition: "already_applied"`):

```json
{ "success": true, "issue": { "id": "...", "status": "Queue" }, "transition": "already_applied" }
```

Rejected transitions (status `400` / `409`) return a structured body:

```json
{ "error": "invalid_transition", "message": "to_stage is not a configured successor of the issue status", "from_stage": "Spec", "to_stage": "In Review" }
```

## Configuration

Migration 283 evolves `relay_stage_config`:

- Existing global rows (`workspace_id NULL`) remain the **default** config used
  by every workspace, preserving existing installations.
- A workspace may define **override rows** (`workspace_id` set, unique per
  `(workspace_id, stage_name)`) to customize stages, owners, and successor
  edges.
- Columns added: `workspace_id`, `agent_id`, `agent_name`, `alt_next_stages`,
  `created_at`. `alt_next_stages` lets one stage fan out to several legal
  successors (e.g. an automated quality gate that can PASS to `CI/CD & Deploy`,
  `Human Review`, or `Done`).

Migration 283 also creates `relay_run_log`, the audit ledger of stage
transitions and their successor tasks.

## Operator cutover / rollback

**Cutover** to the native endpoint is a deployment change that lives outside
this repository: point deployed belt callers at `POST /api/relay/advance-stage`
with the shared bearer, run a parity check comparing a single-stage advance
against the host bridge, and only then retire `multica-bridge.cjs`. Until those
callers migrate, the existing bridge continues to work unchanged.

**Rollback** to the bridge is an in-place switch: the native endpoint and the
bridge both write the same `issue.status`, `relay_stage_config`, and
`relay_run_log` tables, so traffic can be redirected back without any data
migration. The database migration itself is reversible with `migrate down` for
migration 283.

## Tests

`server/internal/handler/relay_advance_stage_test.go` proves:

- an allowed edge advances the issue and enqueues the successor exactly once;
- a disallowed edge leaves the issue and task table unchanged;
- an archived stage owner changes nothing;
- repeated/concurrent delivery creates at most one successor task.
