import type { TestProject } from "vitest/node";
import { spawn } from "node:child_process";
import pg from "pg";

const { Pool } = pg;

/**
 * Vitest globalSetup for the api-server package.
 *
 * Integration tests in this package (`*.integration.test.ts`) talk to a real
 * Postgres database via `DATABASE_URL`. Historically they all ran against the
 * single shared *development* database, which had two problems:
 *
 *   1. Tests insert rows that are never fully removed, so the dev DB grows and
 *      accumulates state over time (drifting serial sequences, leftover
 *      fixtures) — the reason past tests needed unique-slug scoping and
 *      per-file sequence repair.
 *   2. Asserting on global counts was impossible without cross-test
 *      interference.
 *
 * To remove that whole class of fragility this setup provisions a dedicated,
 * disposable test database for each run:
 *
 *   - Connect to the database named in `DATABASE_URL` (the "maintenance" DB)
 *     and `CREATE DATABASE` a uniquely-named throwaway (`mos_test_<...>`).
 *   - Clone the maintenance DB's schema (structure only, no data) into the
 *     throwaway DB so it starts completely empty but with the exact tables,
 *     constraints, and sequences the tests expect.
 *   - Repoint `DATABASE_URL` (and `PGDATABASE`) at that fresh DB *before*
 *     importing `@workspace/db`, so every test worker — forked after this
 *     setup completes — inherits the new connection string and builds its
 *     pool against the throwaway DB rather than the dev DB.
 *   - Drop the throwaway DB in the returned teardown so each run leaves the
 *     server clean. Idle leftovers from crashed runs are swept on startup.
 *
 * A freshly-cloned DB has empty tables and default (correct) sequences by
 * construction, so the previous one-time sequence resync is no longer needed
 * and has been removed.
 *
 * Why clone the schema instead of replaying the checked-in SQL migrations?
 * The migration files in `lib/db/drizzle/` are NOT a complete from-scratch
 * schema — several tables (e.g. `funnel_aliases`) were created by an earlier
 * `drizzle-kit push` workflow and only *referenced*, never `CREATE`d, by the
 * migration files. Replaying them against an empty database fails with
 * "relation does not exist". Cloning the live schema is therefore both more
 * robust and guarantees the test DB matches the schema the app actually runs
 * against. `pg` and the `pg_dump`/`psql` CLIs are used directly (not
 * `@workspace/db`) for the admin work because those statements must run
 * against a *different* database than `@workspace/db`'s pool, which is pinned
 * to whatever `DATABASE_URL` was at import time.
 *
 * Imports of `@workspace/db` are dynamic so that a unit-only run without
 * `DATABASE_URL` doesn't crash at module load — the db package constructs its
 * pool eagerly at import time.
 */

/**
 * Prefix shared by every throwaway test database. Used both when naming a new
 * one and when sweeping idle leftovers from previously crashed runs.
 */
const TEST_DB_PREFIX = "mos_test_";

function makeTestDbName(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${TEST_DB_PREFIX}${Date.now()}_${rand}`;
}

/**
 * Quote a Postgres identifier we generated ourselves. The name is built only
 * from our prefix, a timestamp, and `[a-z0-9]` randomness, so it is already
 * injection-safe; the guard is defence-in-depth before interpolating it into
 * a `CREATE DATABASE` / `DROP DATABASE` statement (which cannot be
 * parameterised).
 */
function quoteIdent(name: string): string {
  if (!/^[a-z0-9_]+$/.test(name)) {
    throw new Error(
      `[test-setup] refusing to use unsafe db identifier: ${name}`,
    );
  }
  return `"${name}"`;
}

/**
 * Tables checked by {@link assertTestDbEmpty}. These are the high-traffic
 * tables every "exact count" assertion in the integration suite depends on, so
 * if any of them already has rows the clean-DB guarantee is broken and counts
 * can't be trusted.
 */
export const KEY_TABLES = [
  "tenants",
  "leads",
  "jobs",
  "background_jobs",
] as const;

/**
 * Minimal shape of a queryable Postgres client — just enough of `pg.Pool` /
 * `pg.Client` for the emptiness check. Declared locally so the check can be
 * unit-tested with a tiny stub instead of a real pool.
 */
export interface CountQueryable {
  query<R>(sql: string): Promise<{ rows: R[] }>;
}

/**
 * Self-enforce the isolation guarantee: a freshly schema-cloned DB must start
 * completely empty. Run BEFORE any worker forks (and thus before any test seeds
 * data) so a stray seed copied in by the clone, a leftover from a misconfigured
 * run, or a `DATABASE_URL` pointed at a populated DB fails the whole run loudly
 * here instead of silently weakening every "exact count" assertion downstream.
 *
 * Counts `KEY_TABLES` and throws if any has rows. Extracted as a standalone
 * exported helper so this protective check is itself unit-tested, independent of
 * vitest's globalSetup lifecycle. Cheap to verify once; invaluable for trusting
 * global-count assertions.
 */
export async function assertTestDbEmpty(
  db: CountQueryable,
  testDbName: string,
  tables: readonly string[] = KEY_TABLES,
): Promise<void> {
  const counts = await Promise.all(
    tables.map(async (table) => {
      const r = await db.query<{ count: string }>(
        // Identifiers come from KEY_TABLES (or an explicit caller list in
        // tests), never user input; quoteIdent is defence-in-depth.
        `SELECT count(*)::text AS count FROM ${quoteIdent(table)}`,
      );
      return { table, count: Number(r.rows[0]?.count ?? 0) };
    }),
  );
  const dirty = counts.filter((c) => c.count > 0);
  if (dirty.length > 0) {
    const detail = dirty.map((c) => `${c.table}=${c.count}`).join(", ");
    throw new Error(
      `[test-setup] expected a clean test database but found leftover ` +
        `rows before any seeding ran (${detail}). The per-run isolated DB ` +
        `(${testDbName}) should start empty — this means the schema clone ` +
        `copied data, DATABASE_URL points at a populated database, or a ` +
        `previous run leaked state. Refusing to run so global-count ` +
        `assertions stay trustworthy.`,
    );
  }
}

/**
 * Clone the schema (no data) of `fromUrl` into `toUrl` by piping
 * `pg_dump --schema-only` straight into `psql`. `ON_ERROR_STOP=1` makes psql
 * fail loudly on the first bad statement instead of silently leaving a
 * half-built schema.
 */
function cloneSchema(fromUrl: string, toUrl: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const dump = spawn(
      "pg_dump",
      [
        "--schema-only",
        "--no-owner",
        "--no-privileges",
        "--no-comments",
        "--dbname",
        fromUrl,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const restore = spawn(
      "psql",
      ["--quiet", "--no-psqlrc", "-v", "ON_ERROR_STOP=1", "--dbname", toUrl],
      { stdio: ["pipe", "ignore", "pipe"] },
    );

    let dumpErr = "";
    let restoreErr = "";
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      dump.kill();
      restore.kill();
      reject(err);
    };

    dump.stderr.on("data", (d) => (dumpErr += d.toString()));
    restore.stderr.on("data", (d) => (restoreErr += d.toString()));
    dump.on("error", fail);
    restore.on("error", fail);
    dump.stdout.pipe(restore.stdin);

    dump.on("close", (code) => {
      if (code !== 0) {
        fail(new Error(`pg_dump exited ${code}: ${dumpErr.trim()}`));
      }
    });
    restore.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        fail(new Error(`psql restore exited ${code}: ${restoreErr.trim()}`));
        return;
      }
      settled = true;
      resolve();
    });
  });
}

export default async function setup(
  project: TestProject,
): Promise<(() => Promise<void>) | void> {
  // `globTestFiles()` with no args returns every test file the project's
  // include patterns match, ignoring the positional file filters passed on
  // the CLI (e.g. `vitest run src/foo.test.ts`). To respect those filters
  // and only provision a DB when integration tests will actually execute,
  // pass the active filename filter from the Vitest instance.
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

  // The DB named in DATABASE_URL is our maintenance/admin DB: we connect to it
  // to create, clone into, and later drop the throwaway test DB. We never
  // write test data to it.
  const maintenanceUrl = process.env.DATABASE_URL;
  const testDbName = makeTestDbName();

  const admin = new Pool({ connectionString: maintenanceUrl });
  try {
    // Sweep idle throwaway DBs left behind by crashed runs (no active
    // connections). DBs belonging to a concurrently-running suite have live
    // backends and are skipped. DROP/CREATE DATABASE cannot run inside a
    // transaction block, so each runs as its own autocommit statement.
    const stale = await admin.query<{ datname: string }>(
      // Literal-prefix match. NOT `LIKE 'mos_test_%'` — `_` is a LIKE wildcard,
      // so that pattern would also match unrelated databases and we DROP these.
      `SELECT d.datname
       FROM pg_database d
       WHERE left(d.datname, length($1)) = $1
         AND NOT EXISTS (
           SELECT 1 FROM pg_stat_activity a WHERE a.datname = d.datname
         )`,
      [TEST_DB_PREFIX],
    );
    for (const { datname } of stale.rows) {
      await admin
        .query(`DROP DATABASE IF EXISTS ${quoteIdent(datname)} WITH (FORCE)`)
        .catch((err) => {
          console.warn(
            `[test-setup] failed to sweep stale test DB ${datname}:`,
            err,
          );
        });
    }
    await admin.query(`CREATE DATABASE ${quoteIdent(testDbName)}`);
  } finally {
    await admin.end().catch(() => {});
  }

  // Build the throwaway DB's connection string from the maintenance one.
  const testUrl = new URL(maintenanceUrl);
  testUrl.pathname = `/${testDbName}`;

  // Clone the live schema (no data) into the fresh DB.
  await cloneSchema(maintenanceUrl, testUrl.toString());

  // Repoint the environment at the fresh DB BEFORE importing @workspace/db so
  // its eagerly-created pool — and every test worker forked after this setup
  // returns — connects to the throwaway DB. PGDATABASE is updated too so any
  // code path that reads it stays consistent.
  process.env.DATABASE_URL = testUrl.toString();
  process.env.PGDATABASE = testDbName;

  // Sanity check the connection target and release the pool so vitest's
  // globalSetup process exits cleanly. Each test worker re-imports
  // `@workspace/db` and gets its own pool client pointed at the same DB.
  const { pool } = await import("@workspace/db");
  try {
    const res = await pool.query<{ db: string }>(
      "SELECT current_database() AS db",
    );
    if (res.rows[0]?.db !== testDbName) {
      throw new Error(
        `[test-setup] expected to connect to ${testDbName} but got ${res.rows[0]?.db}`,
      );
    }

    // Self-enforce the isolation guarantee before any worker forks: the
    // freshly schema-cloned DB must start completely empty. See
    // assertTestDbEmpty for the full rationale.
    await assertTestDbEmpty(pool, testDbName);
  } finally {
    await pool.end().catch(() => {});
  }

  // Teardown: drop the throwaway DB so the run leaves the server clean. Runs
  // after all workers have exited; WITH (FORCE) terminates any straggler
  // backends. Connect to the maintenance DB, never to the DB being dropped.
  return async () => {
    const dropper = new Pool({ connectionString: maintenanceUrl });
    try {
      await dropper.query(
        `DROP DATABASE IF EXISTS ${quoteIdent(testDbName)} WITH (FORCE)`,
      );
    } catch (err) {
      console.warn(
        `[test-setup] failed to drop throwaway test DB ${testDbName}:`,
        err,
      );
    } finally {
      await dropper.end().catch(() => {});
    }
  };
}
