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
}

async function seedJob(opts: SeedJobOpts): Promise<number> {
  const [row] = await db.insert(jobsTable).values({
    tenantId: opts.tenantId,
    jobType: "install",
    stJobNumber: opts.stJobNumber ?? null,
    stInvoiceId: opts.stInvoiceId ?? null,
    stJobIdHash: opts.stJobIdHash ?? null,
    completedAt: opts.completedAt ?? null,
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
