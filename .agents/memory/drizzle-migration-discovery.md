---
name: drizzle migration discovery
description: How the api-server applies SQL migrations — file auto-discovery, not the drizzle _journal.json.
---

# Migration discovery in lib/db

New SQL migrations are applied by a custom runner that auto-discovers any file
matching `\d{4}_.*\.sql` in `lib/db/drizzle/`, applies the ones not present in
the `_applied_migrations` table (tracked by the `NNNN_name` tag), and records
them. Apply SQL must be idempotent in spirit (use `CREATE INDEX IF NOT EXISTS`
etc.) since the runner is the only gate.

**Why:** `lib/db/drizzle/meta/_journal.json` is stale — it stops at 0049 and is
NOT used by the runner. Editing it to register a new migration is unnecessary
and misleading; the file name + `_applied_migrations` table are the source of
truth.

**How to apply:** To add a migration, just drop a correctly-numbered
`NNNN_description.sql` file in `lib/db/drizzle/`. Do not touch `_journal.json`.
On server restart the runner logs `[SchemaMigrations]` and applies/records it.
