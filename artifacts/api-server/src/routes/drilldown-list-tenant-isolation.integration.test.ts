/**
 * Real-Postgres integration coverage for **tenant isolation** on the two
 * drilldown *list* endpoints:
 *
 *   GET /drilldown/leads
 *   GET /drilldown/jobs
 *
 * The sibling unit tests mock the db, so the tenant-scoping WHERE clause
 * (`leads.tenant_id = ?` / `jobs.tenant_id = ?` that `resolveListTenantScope`
 * feeds into the query) is only ever exercised symbolically — the mock returns
 * whatever rows it is told to regardless of the `tenantId` predicate. That
 * cannot prove the live SQL actually partitions one client's leads/jobs from
 * another's. This is the single highest-risk correctness property of these
 * lists: a client must never see another client's leads or jobs.
 *
 * This file seeds TWO tenants whose leads share overlapping source values
 * (Google / Meta) and whose jobs share overlapping status values, plus a
 * tenant-distinctive source each, and asserts against real Postgres that:
 *   - GET /drilldown/leads?tenantId=A never returns tenant B's leads (symmetric)
 *   - GET /drilldown/jobs?tenantId=A  never returns tenant B's jobs (symmetric)
 *   - a shared source/status filter still partitions strictly by tenant
 *   - a tenant-scoped role (client_admin) cannot widen its scope by passing a
 *     different `query.tenantId` — the session tenant always wins
 *   - a broken account (tenant-scoped role, no session tenant) gets 403 rather
 *     than an unscoped query that would leak every tenant's rows
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import express, { type Request, type Response, type NextFunction } from "express";
import http from "http";

const dbModule = await import("@workspace/db");
const { db, tenantsTable, leadsTable, jobsTable } = dbModule;
const routerMod = await import("./drilldown");

// Source values shared by both tenants (the overlap that makes the partition
// non-trivial: the rows are indistinguishable by source, only by tenant_id).
const SOURCE_GOOGLE = "Google";
const SOURCE_META = "Meta";

// Tenant-distinctive sources: each appears for exactly one tenant so leakage is
// directly observable (tenant A must never surface B-only sources and vice-versa).
const SOURCE_A_ONLY = "AOnlySource";
const SOURCE_B_ONLY = "BOnlySource";

const START_DATE = "2026-01-01";
const END_DATE = "2026-12-31";
const IN_RANGE = new Date("2026-03-15T12:00:00.000Z");

interface TenantFx {
  tenantId: number;
  leadIds: number[];
  jobIds: number[];
}

let A: TenantFx;
let B: TenantFx;

// Each app pins a session (role + tenantId). `super_admin` with a null session
// tenant takes its scope from query.tenantId (used to target a seeded tenant);
// `client_admin` is tenant-scoped and must ignore query.tenantId entirely.
function makeApp(session: { userRole: string; tenantId: number | null }): express.Express {
  const a = express();
  a.use(express.json());
  a.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { session: Record<string, unknown> }).session = {
      userId: 1,
      userRole: session.userRole,
      tenantId: session.tenantId,
    };
    next();
  });
  a.use(routerMod.default);
  return a;
}

function getJson(
  expressApp: express.Express,
  reqPath: string,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(expressApp);
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      const req = http.request(
        { hostname: "127.0.0.1", port, path: reqPath, method: "GET" },
        (res) => {
          let data = "";
          res.on("data", (c: Buffer) => (data += c.toString()));
          res.on("end", () => {
            server.close();
            resolve({ status: res.statusCode ?? 0, json: data ? JSON.parse(data) : null });
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
  });
}

type LeadRow = { id: number; tenantId: number; source: string | null };
type JobRow = { id: number; tenantId: number; status: string };

/**
 * Seeds one tenant with three leads (Google / Meta / tenant-only source) and
 * three completed-and-other-status jobs, all stamped in-range so the date
 * filter keeps them. `scale` multiplies job revenue so the two tenants are
 * trivially distinguishable.
 */
async function seedTenant(opts: { label: string; sourceOnly: string; scale: number }): Promise<TenantFx> {
  const slug = `list-iso-${opts.label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const [tenant] = await db
    .insert(tenantsTable)
    .values({ name: `List Iso ${slug}`, clientSlug: slug })
    .returning();

  const mkLead = async (source: string, status: "new" | "contacted" | "sold") => {
    const [lead] = await db
      .insert(leadsTable)
      .values({
        tenantId: tenant.id,
        firstName: "Lead",
        lastName: slug,
        source,
        originalSource: source,
        status,
        createdAt: IN_RANGE,
      })
      .returning();
    return lead;
  };

  const mkJob = async (status: "completed" | "pending", invoiceTotal: number) => {
    const [job] = await db
      .insert(jobsTable)
      .values({
        tenantId: tenant.id,
        jobType: "hvac",
        jobTypeName: "HVAC",
        status,
        revenue: invoiceTotal,
        invoiceTotal,
        invoiceRebateAmount: 0,
        customerName: `Customer ${slug}`,
        createdAt: IN_RANGE,
      })
      .returning();
    return job;
  };

  const s = opts.scale;
  const leadGoogle = await mkLead(SOURCE_GOOGLE, "new");
  const leadMeta = await mkLead(SOURCE_META, "contacted");
  const leadOnly = await mkLead(opts.sourceOnly, "sold");

  const jobCompleted1 = await mkJob("completed", 100 * s);
  const jobCompleted2 = await mkJob("completed", 200 * s);
  const jobPending = await mkJob("pending", 300 * s);

  return {
    tenantId: tenant.id,
    leadIds: [leadGoogle.id, leadMeta.id, leadOnly.id],
    jobIds: [jobCompleted1.id, jobCompleted2.id, jobPending.id],
  };
}

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  A = await seedTenant({ label: "a", sourceOnly: SOURCE_A_ONLY, scale: 1 });
  B = await seedTenant({ label: "b", sourceOnly: SOURCE_B_ONLY, scale: 7 });
});

afterAll(async () => {
  const cleanup = async (fx: TenantFx | undefined) => {
    if (!fx) return;
    try {
      await db.delete(jobsTable).where(inArray(jobsTable.id, fx.jobIds));
      await db.delete(leadsTable).where(inArray(leadsTable.id, fx.leadIds));
      await db.delete(tenantsTable).where(eq(tenantsTable.id, fx.tenantId));
    } catch {
      /* best-effort cleanup */
    }
  };
  await cleanup(A);
  await cleanup(B);
  vi.restoreAllMocks();
});

// super_admin app: scope is driven purely by query.tenantId.
const adminApp = () => makeApp({ userRole: "super_admin", tenantId: null });
const range = (tenantId: number) => `tenantId=${tenantId}&startDate=${START_DATE}&endDate=${END_DATE}`;
// Large limit so all of a tenant's seeded rows come back on one page.
const PAGE = "limit=1000";

describe("GET /drilldown/leads — tenant isolation (real Postgres)", () => {
  it("returns only tenant A's leads, never tenant B's", async () => {
    const res = await getJson(adminApp(), `/drilldown/leads?${range(A.tenantId)}&${PAGE}`);
    expect(res.status).toBe(200);
    const rows = res.json as LeadRow[];

    const ids = rows.map((r) => r.id);
    for (const id of A.leadIds) expect(ids).toContain(id);
    for (const id of B.leadIds) expect(ids).not.toContain(id);
    // Every returned row belongs to tenant A; no B-only source leaks in.
    for (const r of rows) {
      expect(r.tenantId).toBe(A.tenantId);
      expect(r.source).not.toBe(SOURCE_B_ONLY);
    }
  });

  it("returns only tenant B's leads, never tenant A's (symmetric)", async () => {
    const res = await getJson(adminApp(), `/drilldown/leads?${range(B.tenantId)}&${PAGE}`);
    expect(res.status).toBe(200);
    const rows = res.json as LeadRow[];

    const ids = rows.map((r) => r.id);
    for (const id of B.leadIds) expect(ids).toContain(id);
    for (const id of A.leadIds) expect(ids).not.toContain(id);
    for (const r of rows) {
      expect(r.tenantId).toBe(B.tenantId);
      expect(r.source).not.toBe(SOURCE_A_ONLY);
    }
  });

  it("a shared source filter still partitions by tenant (source=Google)", async () => {
    // Both tenants have a Google lead; the filter must only surface the
    // requesting tenant's, never the other tenant's.
    const filter = `&source=${encodeURIComponent(SOURCE_GOOGLE)}`;
    const resA = await getJson(adminApp(), `/drilldown/leads?${range(A.tenantId)}&${PAGE}${filter}`);
    const rowsA = resA.json as LeadRow[];
    expect(rowsA.length).toBeGreaterThan(0);
    for (const r of rowsA) expect(r.tenantId).toBe(A.tenantId);

    const resB = await getJson(adminApp(), `/drilldown/leads?${range(B.tenantId)}&${PAGE}${filter}`);
    const rowsB = resB.json as LeadRow[];
    expect(rowsB.length).toBeGreaterThan(0);
    for (const r of rowsB) expect(r.tenantId).toBe(B.tenantId);

    // The two result sets are disjoint.
    const idsA = new Set(rowsA.map((r) => r.id));
    for (const r of rowsB) expect(idsA.has(r.id)).toBe(false);
  });
});

describe("GET /drilldown/jobs — tenant isolation (real Postgres)", () => {
  it("returns only tenant A's jobs, never tenant B's", async () => {
    const res = await getJson(adminApp(), `/drilldown/jobs?${range(A.tenantId)}&${PAGE}`);
    expect(res.status).toBe(200);
    const rows = res.json as JobRow[];

    const ids = rows.map((r) => r.id);
    for (const id of A.jobIds) expect(ids).toContain(id);
    for (const id of B.jobIds) expect(ids).not.toContain(id);
    for (const r of rows) expect(r.tenantId).toBe(A.tenantId);
  });

  it("returns only tenant B's jobs, never tenant A's (symmetric)", async () => {
    const res = await getJson(adminApp(), `/drilldown/jobs?${range(B.tenantId)}&${PAGE}`);
    expect(res.status).toBe(200);
    const rows = res.json as JobRow[];

    const ids = rows.map((r) => r.id);
    for (const id of B.jobIds) expect(ids).toContain(id);
    for (const id of A.jobIds) expect(ids).not.toContain(id);
    for (const r of rows) expect(r.tenantId).toBe(B.tenantId);
  });

  it("a shared status filter still partitions by tenant (status=completed)", async () => {
    // Both tenants have completed jobs; the filter must only surface the
    // requesting tenant's, never the other tenant's.
    const filter = `&status=completed`;
    const resA = await getJson(adminApp(), `/drilldown/jobs?${range(A.tenantId)}&${PAGE}${filter}`);
    const rowsA = resA.json as JobRow[];
    expect(rowsA.length).toBeGreaterThan(0);
    for (const r of rowsA) {
      expect(r.tenantId).toBe(A.tenantId);
      expect(r.status).toBe("completed");
    }

    const resB = await getJson(adminApp(), `/drilldown/jobs?${range(B.tenantId)}&${PAGE}${filter}`);
    const rowsB = resB.json as JobRow[];
    expect(rowsB.length).toBeGreaterThan(0);
    for (const r of rowsB) {
      expect(r.tenantId).toBe(B.tenantId);
      expect(r.status).toBe("completed");
    }

    // The two result sets are disjoint.
    const idsA = new Set(rowsA.map((r) => r.id));
    for (const r of rowsB) expect(idsA.has(r.id)).toBe(false);
  });
});

describe("Drilldown lists — a tenant-scoped role cannot widen scope via query.tenantId (real Postgres)", () => {
  // client_admin pinned to tenant A, but every request tries to target tenant B
  // through query.tenantId. resolveListTenantScope must force the session tenant.
  const scopedToA = () => makeApp({ userRole: "client_admin", tenantId: A.tenantId });

  it("/drilldown/leads ignores query.tenantId=B and returns only tenant A's leads", async () => {
    const res = await getJson(scopedToA(), `/drilldown/leads?${range(B.tenantId)}&${PAGE}`);
    expect(res.status).toBe(200);
    const rows = res.json as LeadRow[];

    const ids = rows.map((r) => r.id);
    for (const id of A.leadIds) expect(ids).toContain(id);
    for (const id of B.leadIds) expect(ids).not.toContain(id);
    for (const r of rows) expect(r.tenantId).toBe(A.tenantId);
  });

  it("/drilldown/jobs ignores query.tenantId=B and returns only tenant A's jobs", async () => {
    const res = await getJson(scopedToA(), `/drilldown/jobs?${range(B.tenantId)}&${PAGE}`);
    expect(res.status).toBe(200);
    const rows = res.json as JobRow[];

    const ids = rows.map((r) => r.id);
    for (const id of A.jobIds) expect(ids).toContain(id);
    for (const id of B.jobIds) expect(ids).not.toContain(id);
    for (const r of rows) expect(r.tenantId).toBe(A.tenantId);
  });

  it("/drilldown/leads denies a tenant-scoped role with NO session tenant (cannot fall back to unscoped)", async () => {
    // A broken account (tenant-scoped role, no session tenant) must get a 403
    // rather than an unscoped query that would leak every tenant's rows.
    const brokenApp = makeApp({ userRole: "client_admin", tenantId: null });
    const res = await getJson(brokenApp, `/drilldown/leads?${range(A.tenantId)}&${PAGE}`);
    expect(res.status).toBe(403);
    expect((res.json as { error: string }).error).toBe("No tenant assigned");
  });

  it("/drilldown/jobs denies a tenant-scoped role with NO session tenant (cannot fall back to unscoped)", async () => {
    const brokenApp = makeApp({ userRole: "client_admin", tenantId: null });
    const res = await getJson(brokenApp, `/drilldown/jobs?${range(A.tenantId)}&${PAGE}`);
    expect(res.status).toBe(403);
    expect((res.json as { error: string }).error).toBe("No tenant assigned");
  });
});
