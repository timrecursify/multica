## Production migration ownership

The backend/container startup owns schema application: `docker/entrypoint.sh`
invokes `server/cmd/migrate up` using the configured `DATABASE_URL`. Release
automation runs `scripts/check-migration-drift.sh` before and after rollout.
The audit is read-only and exits non-zero with machine-readable drift reasons;
a failed audit blocks rollout and should open the migration-drift sentinel
ticket. Operators must not hand-apply migration SQL. The startup runner's
advisory lock and per-migration ledger writes provide ordered, idempotent
application.
