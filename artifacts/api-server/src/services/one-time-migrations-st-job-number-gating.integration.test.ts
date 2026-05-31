/**
 * Task #824 — Real-Postgres coverage for the per-tenant *credential gating*
 * that the two `2026-05-31_*-st-job-number*` one-time migrations apply before
 * attempting any ServiceTitan recovery.
 *
 * Both migration entries iterate active tenants and call
 * `resolveStAuthConfigForTenant(tenant)`; when it returns null the tenant is
 * `continue`d (no recovery attempted). A regression there — e.g. failing to
 * decrypt a valid config, or no longer requiring the ST fields — would either
 * silently skip recovery for real tenants or attempt it against tenants with no
 * usable credentials, and neither would fail the existing recovery tests (which
 * pass a config in directly).
 *
 * This suite seeds three tenants:
 *   (a) no apiConfig at all,
 *   (b) a real, encrypted ST apiConfig (built with the production
 *       `encryptConfig`), and
 *   (c) an apiConfig that decrypts fine but is missing required ST fields,
 * and asserts that the gating decision — and a loop mirroring the migration —
 * only attempts recovery for the valid one.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";

const dbModule = await import("@workspace/db");
const { db, pool, tenantsTable, jobsTable } = dbModule;

type STInvoice = import("./integrations/service-titan").STInvoice;

const { resolveStAuthConfigForTenant, backfillStJobNumberFromInvoicesForTenant } =
  await import("./one-time-migrations");

const { encryptConfig } = await import("../lib/encryption");

const VALID_ST_CONFIG = {
  serviceTitanClientId: "cid-valid",
  serviceTitanClientSecret: "secret-valid",
  serviceTitanTenantId: "st-tenant-valid",
  serviceTitanAppKey: "appkey-valid",
} as const;

const createdTenants: number[] = [];
const createdJobs: number[] = [];

async function createTestTenant(
  suffix: string,
  apiConfig: string | null,
): Promise<number> {
  const slug = `st-gating-${suffix}`;
  const [row] = await db.insert(tenantsTable).values({
    name: `ST job-number gating ${slug}`,
    clientSlug: slug,
    apiConfig: apiConfig as unknown as undefined,
    isActive: true,
  }).returning();
  createdTenants.push(row.id);
  return row.id;
}

async function seedUnresolvedJob(tenantId: number, stInvoiceId: string): Promise<number> {
  const [row] = await db.insert(jobsTable).values({
    tenantId,
    jobType: "install",
    stInvoiceId,
    stJobNumber: null,
  }).returning();
  createdJobs.push(row.id);
  return row.id;
}

async function getTenant(id: number): Promise<typeof tenantsTable.$inferSelect> {
  const [row] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, id));
  return row;
}

function makeInvoice(id: number, jobNumber: string): STInvoice {
  return {
    id,
    total: "0",
    balance: "0",
    invoiceDate: "2026-01-01",
    paidOn: null,
    job: { id: id * 10, number: jobNumber, type: "Install" },
    items: [],
    active: true,
  };
}

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterAll(async () => {
  if (createdJobs.length > 0) {
    await db.delete(jobsTable).where(inArray(jobsTable.id, createdJobs));
  }
  for (const id of createdTenants) {
    try { await db.delete(tenantsTable).where(eq(tenantsTable.id, id)); } catch { /* best-effort */ }
  }
  vi.restoreAllMocks();
  await pool.end().catch(() => {});
});

describe("resolveStAuthConfigForTenant credential gating (real Postgres, task #824)", () => {
  it("returns null for a tenant with no apiConfig", async () => {
    const tenantId = await createTestTenant("noconfig", null);
    const tenant = await getTenant(tenantId);

    expect(resolveStAuthConfigForTenant(tenant)).toBeNull();
  });

  it("returns the resolved auth config for a tenant with a valid encrypted ST apiConfig", async () => {
    const tenantId = await createTestTenant("valid", encryptConfig(VALID_ST_CONFIG));
    const tenant = await getTenant(tenantId);

    expect(resolveStAuthConfigForTenant(tenant)).toEqual({
      clientId: "cid-valid",
      clientSecret: "secret-valid",
      tenantId: "st-tenant-valid",
      appKey: "appkey-valid",
    });
  });

  it("returns null for a tenant whose apiConfig decrypts but is missing required ST fields", async () => {
    // Decrypts cleanly, but lacks serviceTitanClientSecret + serviceTitanAppKey.
    const tenantId = await createTestTenant(
      "missingfields",
      encryptConfig({ serviceTitanClientId: "cid-only" }),
    );
    const tenant = await getTenant(tenantId);

    expect(resolveStAuthConfigForTenant(tenant)).toBeNull();
  });

  it("returns null for a tenant whose apiConfig is not decryptable", async () => {
    const tenantId = await createTestTenant("undecryptable", "not-a-valid-ciphertext");
    const tenant = await getTenant(tenantId);

    expect(resolveStAuthConfigForTenant(tenant)).toBeNull();
  });
});

describe("migration gating loop only attempts recovery for the valid tenant (real Postgres, task #824)", () => {
  it("skips the no-config and missing-fields tenants and recovers only the valid one", async () => {
    const noConfigId = await createTestTenant("loop-noconfig", null);
    const validId = await createTestTenant("loop-valid", encryptConfig(VALID_ST_CONFIG));
    const missingId = await createTestTenant(
      "loop-missingfields",
      encryptConfig({ serviceTitanClientId: "cid-only" }),
    );

    // Each tenant has a job that WOULD be recovered if recovery were attempted,
    // so any over-eager gating shows up as an extra ServiceTitan fetch / update.
    await seedUnresolvedJob(noConfigId, "6001");
    const validJobId = await seedUnresolvedJob(validId, "6002");
    await seedUnresolvedJob(missingId, "6003");

    const fetchInvoicesByIds = vi.fn(async (_config: unknown, ids: number[]) =>
      ids.map((id) => makeInvoice(id, `JOB-${id}`)),
    );

    // Mirror the migration loop: resolve each tenant's config and only attempt
    // recovery when gating returns a usable config.
    const ids = [noConfigId, validId, missingId];
    const attempted: number[] = [];
    let totalUpdated = 0;
    for (const id of ids) {
      const tenant = await getTenant(id);
      const stConfig = resolveStAuthConfigForTenant(tenant);
      if (!stConfig) continue;
      attempted.push(id);
      totalUpdated += await backfillStJobNumberFromInvoicesForTenant(
        id, stConfig, { fetchInvoicesByIds },
      );
    }

    expect(attempted).toEqual([validId]);
    expect(totalUpdated).toBe(1);
    // ServiceTitan was queried exactly once, for the valid tenant's config only.
    expect(fetchInvoicesByIds).toHaveBeenCalledTimes(1);
    expect(fetchInvoicesByIds).toHaveBeenCalledWith(
      {
        clientId: "cid-valid",
        clientSecret: "secret-valid",
        tenantId: "st-tenant-valid",
        appKey: "appkey-valid",
      },
      [6002],
    );

    const [validJob] = await db.select({ stJobNumber: jobsTable.stJobNumber })
      .from(jobsTable).where(eq(jobsTable.id, validJobId));
    expect(validJob.stJobNumber).toBe("JOB-6002");
  });
});
