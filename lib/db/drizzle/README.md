# Schema migrations

This directory holds the **numbered, checked-in SQL migrations** that build the
PostgreSQL schema for Marketing OS. Add a new file here whenever you change
the Drizzle schema in `lib/db/src/schema/**` — that is how the change
propagates from your laptop to dev, CI, and production.

## How they run

`artifacts/api-server/src/services/schema-migrations.ts` reads every
`NNNN_*.sql` file in this folder on api-server startup, applies anything new,
and records the tag in the `_applied_migrations` table. A pg advisory lock
serializes concurrent boots so only one replica applies migrations at a time.

The api-server build (`artifacts/api-server/build.ts`) copies these files into
`dist/drizzle/` so the deployed bundle ships them alongside the JS.

> `drizzle-kit push` is for **local dev only** (`pnpm --filter @workspace/db
> push`). It is never run in production because it can emit destructive
> `ALTER`/`DROP` statements when the journal drifts from real-world state.

## Adding a new migration

1. Edit the Drizzle schema under `lib/db/src/schema/**`.
2. Create a new SQL file here, numbered one above the highest existing tag
   (e.g. `0052_<short_description>.sql`). The runner only matches
   `^\d{4}_.*\.sql$` and sorts lexicographically, so keep the zero-padding.
3. **Make every statement idempotent.** Use `CREATE TABLE IF NOT EXISTS`,
   `CREATE INDEX IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, and `DO $$ …
   IF NOT EXISTS … END $$` guards for constraints. Dev/staging databases are
   often partially patched by hand or by one-time migrations, and the runner
   has no down-migration story — idempotency is the only safe contract.
4. Open a `BEGIN`/`COMMIT` is unnecessary; the runner wraps each file in a
   transaction. If you need separate transactions, split statement groups with
   the `--> statement-breakpoint` marker (see existing files for the form).
5. Lead with a comment header that names the task and explains the *why*,
   matching the style of recent migrations (e.g.
   `0050_users_non_admin_requires_tenant.sql`).

## Data backfills vs schema changes

DDL goes here. **Data backfills that need application code, transactions
around large row scans, or callbacks into services** belong in
`artifacts/api-server/src/services/one-time-migrations.ts` instead — those are
tracked in `_one_time_migrations` and run after schema migrations on boot.
When a one-time migration also creates a table (as task #416 did for
`lead_status_history`), promote the DDL into a numbered SQL file here so fresh
databases — including test containers that never boot the api-server — get
the table from the start.

## The `meta/` and journal files

`meta/_journal.json` and `meta/*_snapshot.json` are drizzle-kit artefacts. The
startup runner does **not** read them — they only matter if you regenerate
migrations with `drizzle-kit generate`. Hand-written migrations like the ones
in this folder are intentionally not journaled.
