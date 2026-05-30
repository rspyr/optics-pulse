/**
 * Real-Postgres integration test for the ServiceTitan revenue-recompute
 * advisory lock (0x53545256 = "STRV").
 *
 * The companion unit suite (`service-titan-recompute-coalesce.test.ts`) mocks
 * `@workspace/db` and models the advisory lock as an in-memory `Set`. That
 * verifies the coalescing *logic* but NOT that Postgres' real
 * `pg_try_advisory_lock` / `pg_advisory_unlock` behave as the code assumes on a
 * pooled connection — e.g. session vs. transaction scope, or a unlock landing
 * on a different pooled connection than the one that finishes the recompute.
 *
 * This test pins that contract against real Postgres (via `DATABASE_URL`):
 *   - While the STRV lock is held on a SEPARATE session, a concurrent
 *     `recomputeServiceTitanRevenue` must return `{ alreadyRunning: true }`
 *     and run no re-sync.
 *   - After a recompute that acquired the lock itself completes, the lock must
 *     be released — a fresh external acquire of the same key must succeed.
 *
 * The test tenant has NO ServiceTitan API config, so the recompute that DOES
 * win the lock short-circuits inside `syncServiceTitanInvoices` /
 * `syncServiceTitanEstimates` with "ServiceTitan not configured" — exercising
 * the real lock acquire/release path without any network calls. The two
 * "configured?" error sync_log rows it writes are cleaned up in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const dbModule = await import("@workspace/db");
const { db, pool, tenantsTable, integrationSyncLogsTable } = dbModule;

const { recomputeServiceTitanRevenue } = await import("./sync-scheduler");

// Must match the lock key used in `recomputeServiceTitanRevenue`.
const STRV_LOCK_KEY = 0x53545256;

async function createTestTenant(): Promise<number> {
  const slug = `strv-lock-int-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const [row] = await db
    .insert(tenantsTable)
    .values({
      name: `STRV Lock Int ${slug}`,
      clientSlug: slug,
    })
    .returning({ id: tenantsTable.id });
  return row.id;
}

let tenantId: number;

beforeAll(async () => {
  tenantId = await createTestTenant();
});

afterAll(async () => {
  try {
    await db
      .delete(integrationSyncLogsTable)
      .where(eq(integrationSyncLogsTable.tenantId, tenantId));
    await db.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
  } catch {
    /* best-effort cleanup */
  }
});

describe("recomputeServiceTitanRevenue — real Postgres advisory lock", () => {
  it("coalesces a concurrent recompute when the STRV lock is held on another session", async () => {
    // Acquire the STRV lock on a DEDICATED pooled client (a distinct Postgres
    // session). Holding it here forces `recomputeServiceTitanRevenue` — which
    // grabs the same lock via the shared `db` pool — to see got=false.
    const holder = await pool.connect();
    try {
      const acquired = await holder.query(
        "SELECT pg_try_advisory_lock($1, $2) AS got",
        [STRV_LOCK_KEY, tenantId],
      );
      expect(acquired.rows[0].got).toBe(true);

      const result = await recomputeServiceTitanRevenue(tenantId);

      expect(result.alreadyRunning).toBe(true);
      expect(result.invoices.synced).toBe(0);
      expect(result.estimates.error).toBe("skipped");
    } finally {
      // Release the held lock and return the client to the pool.
      await holder
        .query("SELECT pg_advisory_unlock($1, $2)", [STRV_LOCK_KEY, tenantId])
        .catch(() => {});
      holder.release();
    }
  });

  it("releases the lock after a recompute it acquired, so it can be re-acquired", async () => {
    // No external holder this time: the recompute itself wins the STRV lock,
    // runs (short-circuiting on the unconfigured tenant), and must release it.
    const result = await recomputeServiceTitanRevenue(tenantId);
    expect(result.alreadyRunning).toBeFalsy();

    // Prove the lock is free by acquiring it from a separate session. If the
    // recompute had leaked the lock (e.g. unlock ran on a different pooled
    // connection than the acquire), this would return got=false.
    const checker = await pool.connect();
    try {
      const reacquired = await checker.query(
        "SELECT pg_try_advisory_lock($1, $2) AS got",
        [STRV_LOCK_KEY, tenantId],
      );
      expect(reacquired.rows[0].got).toBe(true);
    } finally {
      await checker
        .query("SELECT pg_advisory_unlock($1, $2)", [STRV_LOCK_KEY, tenantId])
        .catch(() => {});
      checker.release();
    }
  });

  it("does not block a recompute for a DIFFERENT tenant (distinct lock objid)", async () => {
    // The lock is keyed by (classid, tenantId). Holding tenant A's lock must
    // not coalesce a recompute for a different tenant.
    const otherTenantId = await createTestTenant();
    const holder = await pool.connect();
    try {
      const acquired = await holder.query(
        "SELECT pg_try_advisory_lock($1, $2) AS got",
        [STRV_LOCK_KEY, tenantId],
      );
      expect(acquired.rows[0].got).toBe(true);

      const result = await recomputeServiceTitanRevenue(otherTenantId);
      expect(result.alreadyRunning).toBeFalsy();
    } finally {
      await holder
        .query("SELECT pg_advisory_unlock($1, $2)", [STRV_LOCK_KEY, tenantId])
        .catch(() => {});
      holder.release();
      await db
        .delete(integrationSyncLogsTable)
        .where(eq(integrationSyncLogsTable.tenantId, otherTenantId));
      await db.delete(tenantsTable).where(eq(tenantsTable.id, otherTenantId));
    }
  });
});
