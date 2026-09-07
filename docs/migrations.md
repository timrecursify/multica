## Production migration ownership

The backend/container startup owns schema application: `docker/entrypoint.sh`
invokes `server/cmd/migrate up` using the configured `DATABASE_URL`. Release
automation runs `scripts/check-migration-drift.sh` before and after rollout.
The audit is read-only and exits non-zero with machine-readable drift reasons;
a failed audit blocks rollout and should open the migration-drift sentinel
ticket. Operators must not hand-apply migration SQL. The startup runner's
advisory lock and per-migration ledger writes provide ordered, idempotent
application.
# Migration slots

Before naming a migration, run `scripts/migrations/claim-slot.sh TICKET` and use
the returned number. Do not hand-pick numeric slots. The allocator serializes
reservations and considers `origin/main`, `schema_migrations` exported to
`PRODUCTION_MIGRATIONS_FILE`, and open-PR filenames in
`OPEN_PR_MIGRATIONS_FILE`. Validate a proposed file before QC with
`scripts/ci/check-migration-slot.sh path/to/migration.sql`.
