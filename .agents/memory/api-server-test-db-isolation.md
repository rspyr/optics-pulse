---
name: api-server isolated test database
description: How api-server integration tests get a fresh throwaway Postgres per run, and why migrations can't build it from scratch.
---

# api-server integration tests run against a disposable cloned DB

`src/test-setup/global-setup.ts` no longer points tests at the shared dev DB.
Each `pnpm vitest run` that matches any `*.integration.test.ts`:
1. `CREATE DATABASE mos_test_<ts>_<rand>` on the maintenance DB (the one in
   the original `DATABASE_URL`), after sweeping idle `mos_test_%` leftovers
   (no active backends) from crashed runs.
2. Clones the live schema into it with `pg_dump --schema-only ... | psql`
   (empty tables, default sequences).
3. Repoints `process.env.DATABASE_URL`/`PGDATABASE` at the throwaway DB
   **before** importing `@workspace/db`.
4. Drops the DB in the returned globalSetup teardown (`DROP DATABASE ... WITH
   (FORCE)`).

**Why clone the schema instead of replaying migrations:** the SQL files in
`lib/db/drizzle/` are NOT a complete from-scratch schema. Tables created by the
pre-runner `drizzle-kit push` era (e.g. `funnel_aliases`) are only *referenced*
by later migrations, never `CREATE`d. Replaying from an empty DB fails with
`relation "funnel_aliases" does not exist`. The dev DB was baselined as
"legacy", so the fresh-DB replay path was never actually exercised.

**Why env mutation in globalSetup reaches the workers:** vitest forks test
workers *after* globalSetup completes, so they inherit the mutated
`process.env`. Verified empirically (`select current_database()` returns the
`mos_test_` name inside a worker).

**One DB per RUN, shared by parallel files (NOT per-file):** globalSetup runs
once and all forked workers inherit the same `mos_test_` DB. With `maxWorkers:4`
up to 4 `*.integration.test.ts` files write to it concurrently. Consequences for
writing/simplifying tests:
- Cross-file uniqueness still matters — keep a distinct *static* per-file slug
  prefix (e.g. `list-iso-`, `cb-sweep-`). The old `-${Date.now()}-${Math.random()}`
  suffix only guarded against a *persistent* DB across runs and is now redundant;
  drop it for stable, debuggable identifiers.
- A global `SELECT COUNT(*)` / "deleted exactly N" assertion is only safe when no
  other file writes that table during the run — and that includes writes via a
  *service* a sibling test exercises, not just direct `.insert`. Safe example:
  re-derive cleanup asserts an exact delete count because its predicate
  (`cancelled` + `rederive_selected_leads`) is produced by no other file.
- Global service sweeps that aren't tenant-scoped (orphan-sync reaper, tracker
  retention prune) can see sibling rows → keep `toBeGreaterThanOrEqual` + assert
  only on own seeded ids.

**How to apply:**
- Needs Postgres superuser/createdb (Replit dev DB user `postgres` has it) and
  `pg_dump`/`psql` on PATH (provided by the postgres nix module).
- `pg` is a direct devDependency of api-server (admin CREATE/DROP needs a pool
  on a *different* DB than `@workspace/db`'s import-time-pinned pool).
- `DROP`/`CREATE DATABASE` cannot run in a transaction/`DO` block — issue each
  as its own autocommit `pool.query`.
- Because the schema is cloned from the live dev DB, a newly-added migration
  file is only present in tests once it has been applied to the dev DB.
