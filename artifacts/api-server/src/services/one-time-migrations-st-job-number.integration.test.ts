/**
 * Task #822 — Real-Postgres coverage for the two ServiceTitan job-number
 * recovery code paths that the `2026-05-31_*-st-job-number*` one-time
 * migrations delegate to:
 *
 *   - `backfillStJobNumberFromInvoicesForTenant` (Task #819): rows that still
 *     retain an internal `st_invoice_id` get their `st_job_number` filled from
 *     the matching invoice's `job.number`.
 *   - `reconcileStJobNumberByDateForTenant` (Task #821): purged rows that lost
 *     their internal ids but kept `st_job_id_hash` get their `st_job_number`
 *     filled by re-fetching completed jobs by date range and matching each
 *     fetched job's hashed id against the retained hash.
 *
 * Both functions take an injectable ServiceTitan fetcher so we feed a mocked
 * response (no live API) while the DB read/write, the invoice-id mapping, the
 * date-window anchoring and the `hashStJobId` key derivation all run for real.
 *
 * The migration entries themselves call these exact functions (after resolving
 * each tenant's encrypted config), so pinning the functions down here means a
 * future refactor of the matching logic — hash key, date window, batch
 * streaming, or the invoice mapping — trips a loud test instead of silently
 * letting the `#id` fallback reappear in the Revenue Attributed view.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq, and, inArray } from "drizzle-orm";

const dbModule = await import("@workspace/db");
const { db, pool, tenantsTable, jobsTable } = dbModule;

const stModule = await import("./integrations/service-titan");
const { hashStJobId } = stModule;
type STJob = import("./integrations/service-titan").STJob;
type STInvoice = import("./integrations/service-titan").STInvoice;

const {
  backfillStJobNumberFromInvoicesForTenant,
  reconcileStJobNumberByDateForTenant,
  backfillStCustomerDataFromInvoicesForTenant,
  backfillStCustomerDataByHashForTenant,
} = await import("./one-time-migrations");

const STUB_CONFIG = {
  clientId: "test-client",
  clientSecret: "test-secret",
  tenantId: "test-st-tenant",
  appKey: "test-app-key",
} as const;

const createdTenants: number[] = [];
const createdJobs: number[] = [];

async function createTestTenant(suffix: string): Promise<number> {
  const slug = `st-jobnum-${suffix}`;
  const [row] = await db.insert(tenantsTable).values({
    name: `ST job-number recovery ${slug}`,
    clientSlug: slug,
  }).returning();
  createdTenants.push(row.id);
  return row.id;
}

interface SeedJobOpts {
  tenantId: number;
  stJobNumber?: string | null;
  stInvoiceId?: string | null;
  stJobIdHash?: string | null;
  completedAt?: Date | null;
  customerName?: string | null;
  serviceAddress?: string | null;
  customerPhone?: string | null;
  customerEmail?: string | null;
}

async function seedJob(opts: SeedJobOpts): Promise<number> {
  const [row] = await db.insert(jobsTable).values({
    tenantId: opts.tenantId,
    jobType: "install",
    stJobNumber: opts.stJobNumber ?? null,
    stInvoiceId: opts.stInvoiceId ?? null,
    stJobIdHash: opts.stJobIdHash ?? null,
    completedAt: opts.completedAt ?? null,
    customerName: opts.customerName ?? null,
    serviceAddress: opts.serviceAddress ?? null,
    customerPhone: opts.customerPhone ?? null,
    customerEmail: opts.customerEmail ?? null,
  }).returning();
  createdJobs.push(row.id);
  return row.id;
}

function makeInvoice(id: number, jobNumber: string | null): STInvoice {
  return {
    id,
    total: "0",
    balance: "0",
    invoiceDate: "2026-01-01",
    paidOn: null,
    job: jobNumber === null ? null : { id: id * 10, number: jobNumber, type: "Install" },
    items: [],
    active: true,
  };
}

function makeJob(id: number, number: string): STJob {
  return {
    id,
    number,
    customerId: 0,
    locationId: 0,
    jobStatus: "Completed",
    summary: "",
    total: 0,
    completedOn: "2026-01-01T00:00:00Z",
  };
}

async function getJobNumber(jobId: number): Promise<string | null> {
  const [row] = await db.select({ stJobNumber: jobsTable.stJobNumber })
    .from(jobsTable).where(eq(jobsTable.id, jobId));
  return row.stJobNumber;
}

async function getJobContact(jobId: number): Promise<{ customerName: string | null; serviceAddress: string | null }> {
  const [row] = await db.select({
    customerName: jobsTable.customerName,
    serviceAddress: jobsTable.serviceAddress,
  }).from(jobsTable).where(eq(jobsTable.id, jobId));
  return row;
}

async function getJobFullContact(jobId: number): Promise<{
  stJobNumber: string | null; customerName: string | null; serviceAddress: string | null;
  customerPhone: string | null; customerEmail: string | null;
}> {
  const [row] = await db.select({
    stJobNumber: jobsTable.stJobNumber,
    customerName: jobsTable.customerName,
    serviceAddress: jobsTable.serviceAddress,
    customerPhone: jobsTable.customerPhone,
    customerEmail: jobsTable.customerEmail,
  }).from(jobsTable).where(eq(jobsTable.id, jobId));
  return row;
}

/** A completed STJob with the `.customer` + `.location` objects `fetchCompletedJobs`
 * expands — the shape the hash backfill reads contact data from. */
function makeJobWithCustomer(
  id: number,
  number: string,
  opts: {
    customerName?: string | null;
    phone?: string | null;
    email?: string | null;
    address?: { street: string; city: string; state: string; zip: string } | null;
  } = {},
): STJob {
  const contacts = [
    ...(opts.phone ? [{ type: "MobilePhone", value: opts.phone }] : []),
    ...(opts.email ? [{ type: "Email", value: opts.email }] : []),
  ];
  return {
    id,
    number,
    customerId: id * 100,
    locationId: id * 1000,
    jobStatus: "Completed",
    summary: "",
    total: 0,
    completedOn: "2026-01-01T00:00:00Z",
    customer: opts.customerName === null
      ? undefined
      : { id: id * 100, name: opts.customerName ?? `Customer ${id}`, contacts },
    location: opts.address ? { id: id * 1000, address: opts.address } : undefined,
  };
}

function makeCustomerInvoice(
  id: number,
  customerName: string | null,
  address: { street?: string; city?: string; state?: string; zip?: string } | null,
): STInvoice {
  return {
    id,
    total: "0",
    balance: "0",
    invoiceDate: "2026-01-01",
    paidOn: null,
    job: { id: id * 10, number: "JN", type: "Install" },
    customer: customerName === null ? null : { id: id * 100, name: customerName },
    locationAddress: address,
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

describe("backfillStJobNumberFromInvoicesForTenant (real Postgres, task #819/#822)", () => {
  it("fills st_job_number from the matching invoice's job.number for a row that retains st_invoice_id but no number", async () => {
    const tenantId = await createTestTenant("inv-fill");
    const jobId = await seedJob({ tenantId, stInvoiceId: "5001", stJobNumber: null });

    const fetchInvoicesByIds = vi.fn(async () => [makeInvoice(5001, "75070")]);
    const updated = await backfillStJobNumberFromInvoicesForTenant(
      tenantId, STUB_CONFIG, { fetchInvoicesByIds },
    );

    expect(updated).toBe(1);
    expect(await getJobNumber(jobId)).toBe("75070");
    // Only the unresolved invoice id was requested from ServiceTitan.
    expect(fetchInvoicesByIds).toHaveBeenCalledWith(STUB_CONFIG, [5001]);
  });

  it("leaves a row that already carries a job number untouched (never re-fetched, never overwritten)", async () => {
    const tenantId = await createTestTenant("inv-skip");
    const jobId = await seedJob({ tenantId, stInvoiceId: "5002", stJobNumber: "EXISTING" });

    const fetchInvoicesByIds = vi.fn(async () => [makeInvoice(5002, "99999")]);
    const updated = await backfillStJobNumberFromInvoicesForTenant(
      tenantId, STUB_CONFIG, { fetchInvoicesByIds },
    );

    expect(updated).toBe(0);
    expect(await getJobNumber(jobId)).toBe("EXISTING");
    // No unresolved rows for this tenant → ServiceTitan must not be queried.
    expect(fetchInvoicesByIds).not.toHaveBeenCalled();
  });

  it("performs no update when ServiceTitan returns no matching invoice", async () => {
    const tenantId = await createTestTenant("inv-nomatch");
    const jobId = await seedJob({ tenantId, stInvoiceId: "5003", stJobNumber: null });

    // ST returns a different invoice id than the one requested.
    const fetchInvoicesByIds = vi.fn(async () => [makeInvoice(9999, "12345")]);
    const updated = await backfillStJobNumberFromInvoicesForTenant(
      tenantId, STUB_CONFIG, { fetchInvoicesByIds },
    );

    expect(updated).toBe(0);
    expect(await getJobNumber(jobId)).toBeNull();
  });

  it("performs no update when the matching invoice has no job.number", async () => {
    const tenantId = await createTestTenant("inv-nonum");
    const jobId = await seedJob({ tenantId, stInvoiceId: "5004", stJobNumber: null });

    const fetchInvoicesByIds = vi.fn(async () => [makeInvoice(5004, null)]);
    const updated = await backfillStJobNumberFromInvoicesForTenant(
      tenantId, STUB_CONFIG, { fetchInvoicesByIds },
    );

    expect(updated).toBe(0);
    expect(await getJobNumber(jobId)).toBeNull();
  });
});

describe("reconcileStJobNumberByDateForTenant (real Postgres, task #821/#822)", () => {
  it("fills st_job_number on a purged row (only st_job_id_hash retained) from a fetched completed job whose hashed id matches", async () => {
    const tenantId = await createTestTenant("rec-fill");
    const stJobId = "880123";
    const hash = hashStJobId(stJobId);
    const jobId = await seedJob({
      tenantId,
      stJobIdHash: hash,
      stJobNumber: null,
      completedAt: new Date("2026-02-01T00:00:00Z"),
    });

    const fetchCompletedJobs = vi.fn(async (
      _config: unknown,
      _modifiedAfter: string | undefined,
      onBatch?: (jobs: STJob[]) => Promise<void>,
    ) => {
      await onBatch?.([makeJob(Number(stJobId), "75070")]);
      return [];
    });

    const updated = await reconcileStJobNumberByDateForTenant(
      tenantId, STUB_CONFIG, { fetchCompletedJobs },
    );

    expect(updated).toBe(1);
    expect(await getJobNumber(jobId)).toBe("75070");
    // The date window is anchored on the earliest affected row (minus a 7-day
    // buffer), so ServiceTitan is asked for everything modified on/after then.
    const modifiedAfter = fetchCompletedJobs.mock.calls[0][1] as string;
    expect(new Date(modifiedAfter).getTime())
      .toBe(new Date("2026-02-01T00:00:00Z").getTime() - 7 * 24 * 60 * 60 * 1000);
  });

  it("leaves a row that already carries a job number untouched", async () => {
    const tenantId = await createTestTenant("rec-skip");
    const stJobId = "880999";
    const jobId = await seedJob({
      tenantId,
      stJobIdHash: hashStJobId(stJobId),
      stJobNumber: "EXISTING",
      completedAt: new Date("2026-02-01T00:00:00Z"),
    });

    const fetchCompletedJobs = vi.fn(async () => []);
    const updated = await reconcileStJobNumberByDateForTenant(
      tenantId, STUB_CONFIG, { fetchCompletedJobs },
    );

    expect(updated).toBe(0);
    expect(await getJobNumber(jobId)).toBe("EXISTING");
    // No rows need reconciliation → ServiceTitan must not be queried.
    expect(fetchCompletedJobs).not.toHaveBeenCalled();
  });

  it("performs no update when ServiceTitan returns no job whose hashed id matches the retained hash", async () => {
    const tenantId = await createTestTenant("rec-nomatch");
    const jobId = await seedJob({
      tenantId,
      stJobIdHash: hashStJobId("880555"),
      stJobNumber: null,
      completedAt: new Date("2026-02-01T00:00:00Z"),
    });

    // ST returns a completed job with a different id → its hash won't match.
    const fetchCompletedJobs = vi.fn(async (
      _config: unknown,
      _modifiedAfter: string | undefined,
      onBatch?: (jobs: STJob[]) => Promise<void>,
    ) => {
      await onBatch?.([makeJob(770000, "12345")]);
      return [];
    });

    const updated = await reconcileStJobNumberByDateForTenant(
      tenantId, STUB_CONFIG, { fetchCompletedJobs },
    );

    expect(updated).toBe(0);
    expect(await getJobNumber(jobId)).toBeNull();
  });
});

describe("backfillStCustomerDataFromInvoicesForTenant (real Postgres, task #825)", () => {
  it("fills a NULL customer name + service address from the invoice's inline customer/location", async () => {
    const tenantId = await createTestTenant("cust-fill-null");
    const jobId = await seedJob({ tenantId, stInvoiceId: "6001", customerName: null, serviceAddress: null });

    const fetchInvoicesByIds = vi.fn(async () => [
      makeCustomerInvoice(6001, "Jane Doe", { street: "1 Main St", city: "Austin", state: "TX", zip: "78701" }),
    ]);
    const updated = await backfillStCustomerDataFromInvoicesForTenant(
      tenantId, STUB_CONFIG, { fetchInvoicesByIds },
    );

    expect(updated).toBe(1);
    expect(await getJobContact(jobId)).toEqual({
      customerName: "Jane Doe",
      serviceAddress: "1 Main St, Austin, TX 78701",
    });
    expect(fetchInvoicesByIds).toHaveBeenCalledWith(STUB_CONFIG, [6001]);
  });

  it("overrides a `Customer <id>` placeholder name but preserves an existing real name", async () => {
    const tenantId = await createTestTenant("cust-placeholder");
    const placeholderJob = await seedJob({ tenantId, stInvoiceId: "6002", customerName: "Customer 123", serviceAddress: "9 Old Rd" });
    const realJob = await seedJob({ tenantId, stInvoiceId: "6003", customerName: "Real Name", serviceAddress: null });

    const fetchInvoicesByIds = vi.fn(async () => [
      makeCustomerInvoice(6002, "Resolved Name", null),
      makeCustomerInvoice(6003, "Should Not Win", { street: "5 New Ave", city: "Dallas", state: "TX", zip: "75201" }),
    ]);
    const updated = await backfillStCustomerDataFromInvoicesForTenant(
      tenantId, STUB_CONFIG, { fetchInvoicesByIds },
    );

    expect(updated).toBe(2);
    // Placeholder name replaced; its already-present address is left untouched.
    expect(await getJobContact(placeholderJob)).toEqual({
      customerName: "Resolved Name",
      serviceAddress: "9 Old Rd",
    });
    // Real name kept; only the missing address is filled from the invoice.
    expect(await getJobContact(realJob)).toEqual({
      customerName: "Real Name",
      serviceAddress: "5 New Ave, Dallas, TX 75201",
    });
  });

  it("never selects a row that has both a real name and an address (ServiceTitan not queried)", async () => {
    const tenantId = await createTestTenant("cust-complete");
    const jobId = await seedJob({ tenantId, stInvoiceId: "6004", customerName: "Complete Co", serviceAddress: "7 Done St" });

    const fetchInvoicesByIds = vi.fn(async () => [makeCustomerInvoice(6004, "Other", null)]);
    const updated = await backfillStCustomerDataFromInvoicesForTenant(
      tenantId, STUB_CONFIG, { fetchInvoicesByIds },
    );

    expect(updated).toBe(0);
    expect(fetchInvoicesByIds).not.toHaveBeenCalled();
    expect(await getJobContact(jobId)).toEqual({
      customerName: "Complete Co",
      serviceAddress: "7 Done St",
    });
  });

  it("performs no update when the invoice carries no customer name and no address", async () => {
    const tenantId = await createTestTenant("cust-empty-invoice");
    const jobId = await seedJob({ tenantId, stInvoiceId: "6005", customerName: null, serviceAddress: null });

    const fetchInvoicesByIds = vi.fn(async () => [makeCustomerInvoice(6005, null, null)]);
    const updated = await backfillStCustomerDataFromInvoicesForTenant(
      tenantId, STUB_CONFIG, { fetchInvoicesByIds },
    );

    expect(updated).toBe(0);
    expect(await getJobContact(jobId)).toEqual({ customerName: null, serviceAddress: null });
  });
});

describe("backfillStCustomerDataByHashForTenant (real Postgres, task #825 bulk recovery)", () => {
  it("recovers name/address/phone/email/number on a fully-purged row by matching the retained hash", async () => {
    const tenantId = await createTestTenant("hash-fill");
    const hash = hashStJobId("700001");
    const jobId = await seedJob({
      tenantId,
      stJobIdHash: hash,
      stJobNumber: null,
      customerName: null,
      serviceAddress: null,
      customerPhone: null,
      customerEmail: null,
      completedAt: new Date("2026-05-11T00:00:00Z"),
    });

    const fetchCompletedJobs = vi.fn(async (
      _cfg: unknown,
      _modifiedAfter: string,
      onBatch?: (jobs: STJob[]) => Promise<void> | void,
    ) => {
      await onBatch?.([makeJobWithCustomer(700001, "75070", {
        customerName: "Mark Lobbestael",
        phone: "5035551234",
        email: "mark@example.com",
        address: { street: "10 Heat Pump Way", city: "Portland", state: "OR", zip: "97201" },
      })]);
    });

    const updated = await backfillStCustomerDataByHashForTenant(
      tenantId, STUB_CONFIG, { fetchCompletedJobs },
    );

    expect(updated).toBe(1);
    expect(await getJobFullContact(jobId)).toEqual({
      stJobNumber: "75070",
      customerName: "Mark Lobbestael",
      serviceAddress: "10 Heat Pump Way, Portland, OR 97201",
      customerPhone: "5035551234",
      customerEmail: "mark@example.com",
    });
  });

  it("fills only the missing fields and never overwrites real existing data", async () => {
    const tenantId = await createTestTenant("hash-partial");
    const hash = hashStJobId("700002");
    const jobId = await seedJob({
      tenantId,
      stJobIdHash: hash,
      stJobNumber: "EXISTING-NUM",
      customerName: "Existing Name",
      serviceAddress: null,
      customerPhone: null,
      customerEmail: "old@example.com",
      completedAt: new Date("2026-05-11T00:00:00Z"),
    });

    const fetchCompletedJobs = vi.fn(async (
      _cfg: unknown,
      _modifiedAfter: string,
      onBatch?: (jobs: STJob[]) => Promise<void> | void,
    ) => {
      await onBatch?.([makeJobWithCustomer(700002, "NEW-NUM", {
        customerName: "Should Not Win",
        phone: "5039999999",
        email: "new@example.com",
        address: { street: "5 New Ave", city: "Dallas", state: "TX", zip: "75201" },
      })]);
    });

    const updated = await backfillStCustomerDataByHashForTenant(
      tenantId, STUB_CONFIG, { fetchCompletedJobs },
    );

    expect(updated).toBe(1);
    // Existing number/name/email preserved; only the blank address + phone filled.
    expect(await getJobFullContact(jobId)).toEqual({
      stJobNumber: "EXISTING-NUM",
      customerName: "Existing Name",
      serviceAddress: "5 New Ave, Dallas, TX 75201",
      customerPhone: "5039999999",
      customerEmail: "old@example.com",
    });
  });

  it("overrides a `Customer <id>` placeholder name with the recovered real name", async () => {
    const tenantId = await createTestTenant("hash-placeholder");
    const hash = hashStJobId("700003");
    const jobId = await seedJob({
      tenantId,
      stJobIdHash: hash,
      customerName: "Customer 555",
      completedAt: new Date("2026-05-11T00:00:00Z"),
    });

    const fetchCompletedJobs = vi.fn(async (
      _cfg: unknown,
      _modifiedAfter: string,
      onBatch?: (jobs: STJob[]) => Promise<void> | void,
    ) => {
      await onBatch?.([makeJobWithCustomer(700003, "JN3", { customerName: "Real Person" })]);
    });

    const updated = await backfillStCustomerDataByHashForTenant(
      tenantId, STUB_CONFIG, { fetchCompletedJobs },
    );

    expect(updated).toBe(1);
    expect((await getJobFullContact(jobId)).customerName).toBe("Real Person");
  });

  it("makes no update when the fetched job's hash matches nothing", async () => {
    const tenantId = await createTestTenant("hash-nomatch");
    const jobId = await seedJob({
      tenantId,
      stJobIdHash: hashStJobId("700004"),
      customerName: null,
      completedAt: new Date("2026-05-11T00:00:00Z"),
    });

    const fetchCompletedJobs = vi.fn(async (
      _cfg: unknown,
      _modifiedAfter: string,
      onBatch?: (jobs: STJob[]) => Promise<void> | void,
    ) => {
      // A different ServiceTitan id → different hash → no match.
      await onBatch?.([makeJobWithCustomer(999999, "OTHER", { customerName: "Nope" })]);
    });

    const updated = await backfillStCustomerDataByHashForTenant(
      tenantId, STUB_CONFIG, { fetchCompletedJobs },
    );

    expect(updated).toBe(0);
    expect((await getJobFullContact(jobId)).customerName).toBeNull();
  });

  it("does not query ServiceTitan when no row needs recovery", async () => {
    const tenantId = await createTestTenant("hash-complete");
    await seedJob({
      tenantId,
      stJobIdHash: hashStJobId("700005"),
      stJobNumber: "N",
      customerName: "Done",
      serviceAddress: "Addr",
      customerPhone: "p",
      customerEmail: "e",
    });

    const fetchCompletedJobs = vi.fn(async () => {});
    const updated = await backfillStCustomerDataByHashForTenant(
      tenantId, STUB_CONFIG, { fetchCompletedJobs },
    );

    expect(updated).toBe(0);
    expect(fetchCompletedJobs).not.toHaveBeenCalled();
  });
});
