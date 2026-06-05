import { pool } from "@workspace/db";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/**
 * Tags of migrations known to NOT have been applied when this runner is
 * introduced. Every other migration file present in `lib/db/drizzle/` is
 * baselined as already-applied on first run. These migrations use `IF NOT EXISTS`
 * / idempotent guards so re-running them is a safe no-op.
 */
const BOOTSTRAP_PENDING = new Set([
  "0028_csr_pause_source",
  "0031_outbound_push_dedup",
  "0033_lead_original_source",
  "0047_meta_integration_rebuild",
  "0079_lead_funnel_attribution",
  "0080_exact_linked_contact_attribution",
  "0081_preserve_exact_linked_contact_matches",
  "0082_estimate_option_metadata",
  "0084_funnel_runs",
  "0085_challenge_run_performance_indexes",
  "0086_funnel_runs_backfill",
]);

function resolveMigrationsDir(): string {
  const candidates: string[] = [];

  // Works in both tsx dev (ESM) and esbuild-bundled cjs — esbuild's
  // node/cjs target rewrites `import.meta.url` to a valid runtime value.
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    candidates.push(
      path.resolve(here, "drizzle"),
      path.resolve(here, "../drizzle"),
      path.resolve(here, "../../drizzle"),
      // tsx dev: this file lives at artifacts/api-server/src/services/,
      // so the monorepo-root migrations live 4 directories up.
      path.resolve(here, "../../../../lib/db/drizzle"),
      // bundled prod: dist/index.cjs sibling copies drizzle/ next to it
      path.resolve(here, "../dist/drizzle"),
    );
  } catch {
    // import.meta.url unavailable — fall through to cwd fallbacks
  }

  candidates.push(
    path.resolve(process.cwd(), "lib/db/drizzle"),
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
      // Detect whether this is a fresh database or a pre-existing one that
      // needs baselining. The `tenants` table is created by migration
      // 0000 and has existed since the first day of the project, so its
      // presence is a reliable sentinel for "legacy DB".
      const sentinelRes = await client.query<{ present: boolean }>(
        `SELECT (to_regclass('public.tenants') IS NOT NULL) AS present`,
      );
      const isLegacyDb = sentinelRes.rows[0]?.present === true;

      if (isLegacyDb) {
        // Legacy DB: record every file as applied EXCEPT the known-missing
        // bootstrap set. This preserves correctness without re-running
        // non-idempotent migrations (e.g. bare `CREATE TABLE`) that would
        // fail against an already-populated schema.
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
          `[SchemaMigrations] Legacy DB detected; baselined ${baselined} migration(s) as applied. Bootstrap-pending: ${[...BOOTSTRAP_PENDING].join(", ")}`,
        );
      } else {
        console.log(
          `[SchemaMigrations] Fresh database detected (no tenants table) — all ${files.length} migration(s) will be applied from scratch`,
        );
      }
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

      // A migration whose first non-empty line is `-- migration:no-transaction`
      // runs OUTSIDE an explicit transaction so it can use statements Postgres
      // forbids inside a transaction block — chiefly `CREATE INDEX CONCURRENTLY`,
      // which builds indexes without holding a write-blocking lock. Such a
      // migration MUST be idempotent (use IF NOT EXISTS / DROP ... IF EXISTS):
      // because there is no surrounding transaction, a mid-way failure leaves
      // partial work that is NOT recorded as applied and will be retried on the
      // next deploy. Each statement must also be its own breakpoint-separated
      // chunk, since multiple statements in one query form an implicit
      // transaction that CONCURRENTLY would reject.
      const firstLine =
        contents
          .split("\n")
          .map((l) => l.trim())
          .find((l) => l.length > 0) ?? "";
      const noTransaction = /^--\s*migration:no-transaction\b/.test(firstLine);

      const chunks = contents
        .split(/-->\s*statement-breakpoint/)
        .map((s) => s.trim())
        .filter(Boolean);

      console.log(
        `[SchemaMigrations] Applying ${tag} (${chunks.length} statement group(s))${noTransaction ? " [no-transaction]" : ""}`,
      );
      if (noTransaction) {
        try {
          for (const chunk of chunks) {
            await client.query(chunk);
          }
          await client.query(
            `INSERT INTO _applied_migrations (tag) VALUES ($1) ON CONFLICT DO NOTHING`,
            [tag],
          );
          appliedCount++;
          console.log(`[SchemaMigrations] Applied ${tag}`);
        } catch (err) {
          console.error(`[SchemaMigrations] Failed to apply ${tag}:`, err);
          throw err;
        }
      } else {
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
