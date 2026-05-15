import type { TestProject } from "vitest/node";

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
 *
 * Before doing any DB work we ask Vitest which test files are actually about
 * to run. If any `*.integration.test.ts` files matched the current filter
 * but `DATABASE_URL` is unset, we fail fast with an actionable message
 * instead of letting each suite explode with a confusing pg connection
 * error several seconds in. Pure unit-only runs (no integration files
 * matched) continue to work without `DATABASE_URL`.
 */
export default async function setup(project: TestProject): Promise<void> {
  // `globTestFiles()` with no args returns every test file the project's
  // include patterns match, ignoring the positional file filters passed on
  // the CLI (e.g. `vitest run src/foo.test.ts`). To respect those filters
  // and only fail-fast when integration tests will actually execute, pass
  // the active filename filter from the Vitest instance.
  const filenamePattern = (
    project.vitest as unknown as { filenamePattern?: string[] }
  ).filenamePattern;
  const { testFiles } = await project.globTestFiles(filenamePattern);
  const integrationFiles = testFiles.filter((f) =>
    f.endsWith(".integration.test.ts"),
  );

  if (integrationFiles.length === 0) {
    return;
  }

  if (!process.env.DATABASE_URL) {
    throw new Error(
      "[test-setup] DATABASE_URL is required to run integration tests in " +
        "@workspace/api-server, but it is not set.\n" +
        `Matched ${integrationFiles.length} integration test file(s), e.g. ` +
        `${integrationFiles[0]}.\n` +
        "Set DATABASE_URL to a Postgres connection string before running " +
        "`pnpm test`, or restrict the run to unit tests only " +
        "(e.g. `vitest run --exclude '**/*.integration.test.ts'`).",
    );
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
