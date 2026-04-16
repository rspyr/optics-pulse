import { pool } from "@workspace/db";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/**
 * Tags of migrations known to NOT have been applied when this runner is
 * introduced. Every other migration file present in `lib/db/drizzle/` is
 * baselined as already-applied on first run. These three use `IF NOT EXISTS`
 * / idempotent guards so re-running them is a safe no-op.
 */
const BOOTSTRAP_PENDING = new Set([
  "0028_csr_pause_source",
  "0031_outbound_push_dedup",
  "0033_lead_original_source",
]);

function resolveMigrationsDir(): string {
  const candidates: string[] = [];

  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    candidates.push(path.resolve(here, "drizzle"));
    candidates.push(path.resolve(here, "../drizzle"));
    candidates.push(path.resolve(here, "../../drizzle"));
  } catch {
    // import.meta.url not available in bundled cjs — fall through
  }

  // esbuild replaces __dirname in the bundled dist/index.cjs
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const maybeDirname = (globalThis as any).__dirname as string | undefined;
  if (typeof maybeDirname === "string") {
    candidates.push(path.resolve(maybeDirname, "drizzle"));
    candidates.push(path.resolve(maybeDirname, "../drizzle"));
  }

  // Dev / workspace-root fallbacks
  candidates.push(path.resolve(process.cwd(), "lib/db/drizzle"));
  candidates.push(path.resolve(process.cwd(), "../../lib/db/drizzle"));
  candidates.push(
    path.resolve(process.cwd(), "artifacts/api-server/dist/drizzle"),
  );

  for (const c of candidates) {
    try {
      if (fs.statSync(c).isDirectory()) return c;
    } catch {
      // try next
    }
  }

  throw new Error(
    `[SchemaMigrations] Could not locate migrations directory. Tried:\n  - ${candidates.join("\n  - ")}`,
  );
}

/**
 * Safe, additive-only migration runner.
 *
 * Tracks applied migrations in a dedicated `_applied_migrations` table so each
 * SQL file is executed at most once per database. On the very first run the
 * runner baselines the tracking table with every migration currently present
 * on disk EXCEPT those listed in {@link BOOTSTRAP_PENDING}, which is the list
 * of known-missing migrations we want the next deploy to apply.
 *
 * This replaces the prior approach of running `drizzle-kit push` on deploy,
 * which generated destructive ALTER TABLE statements when the journal drifted
 * from the actual database state.
 */
/**
 * Arbitrary constant used with pg advisory locks so that when multiple
 * api-server replicas boot simultaneously only one runs migrations at a
 * time. Others wait on the lock and then observe an already-populated
 * `_applied_migrations` table.
 */
const ADVISORY_LOCK_ID = 0x4d4f53_4d494752; // "MOS_MIGR"

export async function runSchemaMigrations(): Promise<void> {
  const client = await pool.connect();
  let lockAcquired = false;
  try {
    await client.query(`SELECT pg_advisory_lock($1)`, [ADVISORY_LOCK_ID]);
    lockAcquired = true;

    await client.query(`
      CREATE TABLE IF NOT EXISTS _applied_migrations (
        tag TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const dir = resolveMigrationsDir();
    const files = fs
      .readdirSync(dir)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .sort();

    if (files.length === 0) {
      console.warn(`[SchemaMigrations] No migration files found in ${dir}`);
      return;
    }

    const countRes = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM _applied_migrations`,
    );
    const isFirstRun = Number(countRes.rows[0]?.count ?? "0") === 0;

    if (isFirstRun) {
      let baselined = 0;
      for (const f of files) {
        const tag = path.basename(f, ".sql");
        if (BOOTSTRAP_PENDING.has(tag)) continue;
        await client.query(
          `INSERT INTO _applied_migrations (tag) VALUES ($1) ON CONFLICT DO NOTHING`,
          [tag],
        );
        baselined++;
      }
      console.log(
        `[SchemaMigrations] Baselined ${baselined} migration(s) as applied; ${BOOTSTRAP_PENDING.size} bootstrap-pending eligible to run`,
      );
    }

    const appliedRes = await client.query<{ tag: string }>(
      `SELECT tag FROM _applied_migrations`,
    );
    const applied = new Set(appliedRes.rows.map((r) => r.tag));

    let appliedCount = 0;
    for (const file of files) {
      const tag = path.basename(file, ".sql");
      if (applied.has(tag)) continue;

      const contents = fs.readFileSync(path.join(dir, file), "utf8");
      const chunks = contents
        .split(/-->\s*statement-breakpoint/)
        .map((s) => s.trim())
        .filter(Boolean);

      console.log(
        `[SchemaMigrations] Applying ${tag} (${chunks.length} statement group(s))`,
      );
      try {
        await client.query("BEGIN");
        for (const chunk of chunks) {
          await client.query(chunk);
        }
        await client.query(
          `INSERT INTO _applied_migrations (tag) VALUES ($1)`,
          [tag],
        );
        await client.query("COMMIT");
        appliedCount++;
        console.log(`[SchemaMigrations] Applied ${tag}`);
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        console.error(`[SchemaMigrations] Failed to apply ${tag}:`, err);
        throw err;
      }
    }

    if (appliedCount === 0) {
      console.log(`[SchemaMigrations] Schema is up to date`);
    } else {
      console.log(
        `[SchemaMigrations] Applied ${appliedCount} new migration(s)`,
      );
    }
  } finally {
    if (lockAcquired) {
      await client
        .query(`SELECT pg_advisory_unlock($1)`, [ADVISORY_LOCK_ID])
        .catch(() => {});
    }
    client.release();
  }
}
