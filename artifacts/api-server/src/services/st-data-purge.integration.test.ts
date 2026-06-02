/**
 * Task #826 — Real-Postgres coverage for the ServiceTitan data-purge job
 * (`purgeExpiredStData`). This is the compliance-sensitive path that, after the
 * blank-customer-data incident, was hardened so it:
 *
 *   - RETAINS phone + email indefinitely (Task #825) alongside the
 *     already-retained customer name, service address and job number — only the
 *     internal ServiceTitan ids (st_job_id / st_customer_id / st_location_id)
 *     are ever nulled.
 *   - DEFERS the normal 24h purge of those internal ids while the customer name
 *     is still missing or only the `Customer <id>` placeholder — stripping the
 *     ids before a real name is captured would turn the row into a permanently
 *     unrecoverable-by-id orphan (the exact failure this work prevents).
 *   - Still enforces a HARD 7-day cutoff: past that window the internal ids are
 *     purged regardless of enrichment state so they can never linger forever.
 *
 * The purge runs against every job globally, so each test seeds its own rows
 * and asserts ONLY on those ids — it never depends on the global row set.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";

const dbModule = await import("@workspace/db");
const { db, pool, tenantsTable, jobsTable } = dbModule;

const { purgeExpiredStData } = await import("./st-data-purge");

const createdTenants: number[] = [];
const createdJobs: number[] = [];

const DAY_MS = 24 * 60 * 60 * 1000;

async function createTestTenant(suffix: string): Promise<number> {
  const slug = `st-purge-${suffix}`;
  const [row] = await db.insert(tenantsTable).values({
    name: `ST purge ${slug}`,
    clientSlug: slug,
  }).returning();
  createdTenants.push(row.id);
  return row.id;
}

interface SeedJobOpts {
  tenantId: number;
  stJobId?: string | null;
  stCustomerId?: string | null;
  stLocationId?: string | null;
  stJobNumber?: string | null;
  customerName?: string | null;
  serviceAddress?: string | null;
  customerPhone?: string | null;
  customerEmail?: string | null;
  stDataExpiresAt?: Date | null;
  createdAt?: Date | null;
}

async function seedJob(opts: SeedJobOpts): Promise<number> {
  const [row] = await db.insert(jobsTable).values({
    tenantId: opts.tenantId,
    jobType: "install",
    stJobId: opts.stJobId ?? null,
    stCustomerId: opts.stCustomerId ?? null,
    stLocationId: opts.stLocationId ?? null,
    stJobNumber: opts.stJobNumber ?? null,
    customerName: opts.customerName ?? null,
    serviceAddress: opts.serviceAddress ?? null,
    customerPhone: opts.customerPhone ?? null,
    customerEmail: opts.customerEmail ?? null,
    stDataExpiresAt: opts.stDataExpiresAt ?? null,
    ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
  }).returning();
  createdJobs.push(row.id);
  return row.id;
}

async function getJob(jobId: number) {
  const [row] = await db.select({
    stJobId: jobsTable.stJobId,
    stCustomerId: jobsTable.stCustomerId,
    stLocationId: jobsTable.stLocationId,
    stJobNumber: jobsTable.stJobNumber,
    customerName: jobsTable.customerName,
    serviceAddress: jobsTable.serviceAddress,
    customerPhone: jobsTable.customerPhone,
    customerEmail: jobsTable.customerEmail,
  }).from(jobsTable).where(eq(jobsTable.id, jobId));
  return row;
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

describe("purgeExpiredStData (real Postgres, task #826)", () => {
  it("nulls only the internal ST ids while RETAINING name, address, job number, phone and email", async () => {
    const tenantId = await createTestTenant("retain-contact");
    const jobId = await seedJob({
      tenantId,
      stJobId: "900001",
      stCustomerId: "c-900001",
      stLocationId: "l-900001",
      stJobNumber: "75070",
      customerName: "Mark Lobbestael",
      serviceAddress: "10 Heat Pump Way, Portland, OR 97201",
      customerPhone: "5035551234",
      customerEmail: "mark@example.com",
      // Real name present + already expired, but still inside the 7-day window:
      // the normal 24h purge applies, stripping ONLY the internal ids.
      stDataExpiresAt: new Date(Date.now() - DAY_MS),
    });

    await purgeExpiredStData();

    expect(await getJob(jobId)).toEqual({
      stJobId: null,
      stCustomerId: null,
      stLocationId: null,
      stJobNumber: "75070",
      customerName: "Mark Lobbestael",
      serviceAddress: "10 Heat Pump Way, Portland, OR 97201",
      customerPhone: "5035551234",
      customerEmail: "mark@example.com",
    });
  });

  it("does NOT strip the internal ids while the customer name is still a `Customer <id>` placeholder (inside the 7-day window)", async () => {
    const tenantId = await createTestTenant("defer-placeholder");
    const jobId = await seedJob({
      tenantId,
      stJobId: "900002",
      stCustomerId: "c-900002",
      stLocationId: "l-900002",
      customerName: "Customer 900002",
      // Expired by the 24h rule, but the name is not yet recoverable — the ids
      // are the only key to re-fetch the real customer, so they must survive.
      stDataExpiresAt: new Date(Date.now() - DAY_MS),
    });

    await purgeExpiredStData();

    const row = await getJob(jobId);
    expect(row.stJobId).toBe("900002");
    expect(row.stCustomerId).toBe("c-900002");
    expect(row.stLocationId).toBe("l-900002");
  });

  it("does NOT strip the internal ids while the customer name is still missing (inside the 7-day window)", async () => {
    const tenantId = await createTestTenant("defer-null");
    const jobId = await seedJob({
      tenantId,
      stJobId: "900003",
      stCustomerId: "c-900003",
      stLocationId: "l-900003",
      customerName: null,
      // Old enough for the fallback 24h rule (no stDataExpiresAt) but recent
      // enough to be well inside the hard cutoff.
      createdAt: new Date(Date.now() - 2 * DAY_MS),
    });

    await purgeExpiredStData();

    const row = await getJob(jobId);
    expect(row.stJobId).toBe("900003");
    expect(row.stCustomerId).toBe("c-900003");
    expect(row.stLocationId).toBe("l-900003");
  });

  it("hard 7-day cutoff purges the internal ids regardless of enrichment state (placeholder name)", async () => {
    const tenantId = await createTestTenant("hard-cutoff");
    const jobId = await seedJob({
      tenantId,
      stJobId: "900004",
      stCustomerId: "c-900004",
      stLocationId: "l-900004",
      customerName: "Customer 900004",
      // Past the hard 7-day bound → ids purged even though the name never
      // became recoverable. The retained fields still survive.
      createdAt: new Date(Date.now() - 8 * DAY_MS),
    });

    await purgeExpiredStData();

    const row = await getJob(jobId);
    expect(row.stJobId).toBeNull();
    expect(row.stCustomerId).toBeNull();
    expect(row.stLocationId).toBeNull();
    expect(row.customerName).toBe("Customer 900004");
  });

  it("leaves a not-yet-expired row with a real name fully intact (nothing purged before its 24h window)", async () => {
    const tenantId = await createTestTenant("not-expired");
    const jobId = await seedJob({
      tenantId,
      stJobId: "900005",
      stCustomerId: "c-900005",
      stLocationId: "l-900005",
      customerName: "Fresh Customer",
      // Expiry is in the future and the row is brand-new → nothing to purge.
      stDataExpiresAt: new Date(Date.now() + DAY_MS),
    });

    await purgeExpiredStData();

    const row = await getJob(jobId);
    expect(row.stJobId).toBe("900005");
    expect(row.stCustomerId).toBe("c-900005");
    expect(row.stLocationId).toBe("l-900005");
  });
});
