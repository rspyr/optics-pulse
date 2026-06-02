/**
 * Task #826 — Real-Postgres coverage for the ServiceTitan invoice sync's
 * customer-data handling (`processInvoiceBatch`, reached via
 * `syncServiceTitanInvoices`). After the blank-customer-data incident the
 * invoice sync became authoritative for customer name + service address, so it:
 *
 *   - CREATES a row for an invoice-only job (no matching completed-jobs row)
 *     straight from the invoice's inline customer/location, rather than dropping
 *     the data — otherwise the job never appears in revenue attribution.
 *   - OVERRIDES the `Customer <id>` placeholder name (and a NULL name) the job
 *     sync writes when ServiceTitan returned no customer object.
 *   - NEVER overwrites a real existing customer name with the invoice's value.
 *
 * Only `fetchInvoices` is stubbed (fed a mocked batch); every other path —
 * tenant-config decryption, the job-match lookup, parseInvoiceData, the
 * insert/update and the sync-log finalization — runs against real Postgres.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { encryptConfig } from "../lib/encryption";
import type { STInvoice } from "./integrations/service-titan";

// ─── Stub fetchInvoices BEFORE importing sync-scheduler ──────────────────────
const stMocks = vi.hoisted(() => ({
  invoices: [] as STInvoice[],
}));

vi.mock("./integrations/service-titan", async () => {
  const actual = await vi.importActual<typeof import("./integrations/service-titan")>("./integrations/service-titan");
  return {
    ...actual,
    fetchInvoices: vi.fn(async (
      _config: unknown,
      _modifiedAfter: string | undefined,
      processBatch?: (invoices: STInvoice[]) => Promise<void>,
    ) => {
      if (stMocks.invoices.length > 0) await processBatch?.(stMocks.invoices);
      return stMocks.invoices;
    }),
  };
});

// Notifications are noisy and not under test here.
vi.mock("./notifications", () => ({
  emitSyncFailureNotification: vi.fn().mockResolvedValue(undefined),
  emitSyncCatchupNotification: vi.fn().mockResolvedValue(undefined),
}));

const dbModule = await import("@workspace/db");
const { db, pool, tenantsTable, jobsTable, integrationSyncLogsTable } = dbModule;
const stModule = await import("./integrations/service-titan");
const { hashStJobId } = stModule;
const { syncServiceTitanInvoices } = await import("./sync-scheduler");

const createdTenants: number[] = [];
const createdJobs: number[] = [];

async function createTestTenant(suffix: string): Promise<number> {
  const slug = `st-inv-${suffix}`;
  const [row] = await db.insert(tenantsTable).values({
    name: `ST invoice sync ${slug}`,
    clientSlug: slug,
    stSyncPaused: false,
    apiConfig: encryptConfig({
      serviceTitanClientId: "test-client",
      serviceTitanClientSecret: "test-secret",
      serviceTitanAppKey: "test-app-key",
      serviceTitanTenantId: "test-st-tenant",
    }) as unknown as typeof tenantsTable.$inferInsert.apiConfig,
  }).returning();
  createdTenants.push(row.id);
  return row.id;
}

interface SeedJobOpts {
  tenantId: number;
  stJobId?: string | null;
  stJobIdHash?: string | null;
  stJobNumber?: string | null;
  customerName?: string | null;
  serviceAddress?: string | null;
}

async function seedJob(opts: SeedJobOpts): Promise<number> {
  const [row] = await db.insert(jobsTable).values({
    tenantId: opts.tenantId,
    jobType: "install",
    stJobId: opts.stJobId ?? null,
    stJobIdHash: opts.stJobIdHash ?? null,
    stJobNumber: opts.stJobNumber ?? null,
    customerName: opts.customerName ?? null,
    serviceAddress: opts.serviceAddress ?? null,
  }).returning();
  createdJobs.push(row.id);
  return row.id;
}

function makeInvoice(
  jobStId: number,
  opts: {
    jobNumber?: string | null;
    customerName?: string | null;
    customerId?: number | null;
    locationId?: number | null;
    address?: { street?: string; city?: string; state?: string; zip?: string } | null;
  } = {},
): STInvoice {
  return {
    id: jobStId * 7,
    total: "0",
    balance: "0",
    invoiceDate: "2026-01-01",
    paidOn: null,
    job: { id: jobStId, number: opts.jobNumber ?? "JN", type: "Install" },
    customer: opts.customerName === undefined || opts.customerName === null
      ? null
      : { id: opts.customerId ?? jobStId * 100, name: opts.customerName },
    location: opts.locationId ? { id: opts.locationId, name: "Loc" } : undefined,
    locationAddress: opts.address ?? null,
    items: [],
    active: true,
  };
}

async function getJobByStJobId(tenantId: number, stJobId: string) {
  const [row] = await db.select({
    id: jobsTable.id,
    stJobId: jobsTable.stJobId,
    stJobIdHash: jobsTable.stJobIdHash,
    stJobNumber: jobsTable.stJobNumber,
    customerName: jobsTable.customerName,
    serviceAddress: jobsTable.serviceAddress,
    stCustomerId: jobsTable.stCustomerId,
    stLocationId: jobsTable.stLocationId,
    hasInvoice: jobsTable.hasInvoice,
  }).from(jobsTable).where(eq(jobsTable.stJobId, stJobId));
  if (row) createdJobs.push(row.id);
  return row;
}

async function getJobById(jobId: number) {
  const [row] = await db.select({
    stJobNumber: jobsTable.stJobNumber,
    customerName: jobsTable.customerName,
    serviceAddress: jobsTable.serviceAddress,
    hasInvoice: jobsTable.hasInvoice,
  }).from(jobsTable).where(eq(jobsTable.id, jobId));
  return row;
}

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterAll(async () => {
  if (createdTenants.length > 0) {
    await db.delete(integrationSyncLogsTable).where(inArray(integrationSyncLogsTable.tenantId, createdTenants));
  }
  if (createdJobs.length > 0) {
    await db.delete(jobsTable).where(inArray(jobsTable.id, createdJobs));
  }
  for (const id of createdTenants) {
    try { await db.delete(tenantsTable).where(eq(tenantsTable.id, id)); } catch { /* best-effort */ }
  }
  vi.restoreAllMocks();
  await pool.end().catch(() => {});
});

describe("syncServiceTitanInvoices — invoice-only row creation (task #826)", () => {
  it("creates a new job row from the invoice when no matching job exists, carrying name/address/number and the internal ids", async () => {
    const tenantId = await createTestTenant("create");
    stMocks.invoices = [
      makeInvoice(810001, {
        jobNumber: "75070",
        customerName: "Jane Doe",
        customerId: 4242,
        locationId: 9090,
        address: { street: "1 Main St", city: "Austin", state: "TX", zip: "78701" },
      }),
    ];

    const result = await syncServiceTitanInvoices(tenantId);
    expect(result.synced).toBe(1);

    const row = await getJobByStJobId(tenantId, "810001");
    expect(row).toBeTruthy();
    expect(row.stJobIdHash).toBe(hashStJobId("810001"));
    expect(row.stJobNumber).toBe("75070");
    expect(row.customerName).toBe("Jane Doe");
    expect(row.serviceAddress).toBe("1 Main St, Austin, TX 78701");
    // Internal customer/location ids are persisted so contact enrichment can run
    // before the 24h purge clears them.
    expect(row.stCustomerId).toBe("4242");
    expect(row.stLocationId).toBe("9090");
    expect(row.hasInvoice).toBe(true);
  });
});

describe("syncServiceTitanInvoices — placeholder / missing name override (task #826)", () => {
  it("overrides a `Customer <id>` placeholder name with the invoice's real customer name", async () => {
    const tenantId = await createTestTenant("placeholder");
    const jobId = await seedJob({
      tenantId,
      stJobId: "810002",
      stJobIdHash: hashStJobId("810002"),
      customerName: "Customer 810002",
      serviceAddress: "Existing Addr",
    });
    stMocks.invoices = [makeInvoice(810002, { jobNumber: "75071", customerName: "Resolved Name" })];

    const result = await syncServiceTitanInvoices(tenantId);
    expect(result.synced).toBe(1);

    const row = await getJobById(jobId);
    expect(row.customerName).toBe("Resolved Name");
    // An already-present real address is preserved over the invoice's.
    expect(row.serviceAddress).toBe("Existing Addr");
    expect(row.stJobNumber).toBe("75071");
    expect(row.hasInvoice).toBe(true);
  });

  it("fills a NULL customer name from the invoice", async () => {
    const tenantId = await createTestTenant("nullname");
    const jobId = await seedJob({
      tenantId,
      stJobId: "810003",
      stJobIdHash: hashStJobId("810003"),
      customerName: null,
    });
    stMocks.invoices = [makeInvoice(810003, {
      customerName: "Filled From Invoice",
      address: { street: "5 New Ave", city: "Dallas", state: "TX", zip: "75201" },
    })];

    await syncServiceTitanInvoices(tenantId);

    const row = await getJobById(jobId);
    expect(row.customerName).toBe("Filled From Invoice");
    expect(row.serviceAddress).toBe("5 New Ave, Dallas, TX 75201");
  });
});

describe("syncServiceTitanInvoices — never overwrites a real existing name (task #826)", () => {
  it("keeps the existing real customer name and does not replace it with the invoice's", async () => {
    const tenantId = await createTestTenant("keepname");
    const jobId = await seedJob({
      tenantId,
      stJobId: "810004",
      stJobIdHash: hashStJobId("810004"),
      customerName: "Real Existing Name",
      serviceAddress: null,
    });
    stMocks.invoices = [makeInvoice(810004, {
      customerName: "Should Not Win",
      address: { street: "9 Other Rd", city: "Houston", state: "TX", zip: "77002" },
    })];

    const result = await syncServiceTitanInvoices(tenantId);
    expect(result.synced).toBe(1);

    const row = await getJobById(jobId);
    // Real name preserved; only the missing address is filled from the invoice.
    expect(row.customerName).toBe("Real Existing Name");
    expect(row.serviceAddress).toBe("9 Other Rd, Houston, TX 77002");
  });
});
