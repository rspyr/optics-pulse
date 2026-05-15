/**
 * Vitest globalSetup for the api-server package.
 *
 * Runs once before any test suite (unit or integration) starts. Integration
 * tests in this package talk to a real Postgres database via `DATABASE_URL`;
 * applying the checked-in SQL migrations here means a fresh DB (CI container,
 * a newly-provisioned dev DB, or a contributor's local) is brought up to the
 * current schema automatically. Without this, adding a new file under
 * `lib/db/drizzle/` breaks integration tests with "relation does not exist"
 * until somebody patches the DB by hand.
 *
 * The runner is idempotent: it records applied tags in `_applied_migrations`,
 * so repeated test runs against the same DB are a fast no-op.
 *
 * Imports of `@workspace/db` and the migration runner are dynamic so that a
 * unit-only run without `DATABASE_URL` doesn't crash at module load — the
 * db package constructs its pool eagerly at import time.
 */
export default async function setup(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.warn(
      "[test-setup] DATABASE_URL is not set; skipping schema migration step. " +
        "Integration tests will fail if they reach the database.",
    );
    return;
  }

  const { runSchemaMigrations } = await import(
    "../services/schema-migrations.js"
  );
  const { pool } = await import("@workspace/db");

  await runSchemaMigrations();

  // Release the shared pool so vitest's globalSetup process exits cleanly.
  // Each test suite re-imports `@workspace/db` and gets its own pool client.
  await pool.end().catch(() => {});
}
