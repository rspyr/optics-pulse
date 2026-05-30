/**
 * Real-Postgres integration coverage for **tenant isolation** on the Revenue
 * Attributed drilldown:
 *
 *   GET /drilldown/revenue-attributed
 *   GET /drilldown/revenue-attributed/summary
 *   GET /drilldown/revenue-attributed/facets
 *
 * The sibling unit test (`drilldown-revenue-attributed.test.ts`) mocks the db,
 * so the tenant-scoping WHERE clause is only ever exercised symbolically — the
 * mock returns whatever rows it is told to regardless of the `tenantId`
 * predicate. That cannot prove the live SQL actually partitions one tenant's
 * jobs/totals/facets from another's. This is the single highest-risk
 * correctness property of a multi-tenant revenue report: a client must never
 * see another client's jobs, totals, or filter values.
 *
 * This file seeds TWO tenants whose completed jobs share overlapping funnel
 * (Heat Pump / Furnace) and source (Google / Meta) values, plus a tenant-only
 * distinctive funnel/source each, and asserts against real Postgres that:
 *   - the list never returns the other tenant's job ids/rows
 *   - /summary totals only the requesting tenant's jobs
 *   - /facets only offers the requesting tenant's distinct funnels/sources
 *   - a tenant-scoped role (client_admin) cannot widen its scope by passing a
 *     different `query.tenantId` — the session tenant always wins
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import express, { type Request, type Response, type NextFunction } from "express";
import http from "http";

const dbModule = await import("@workspace/db");
const { db, tenantsTable, leadsTable, jobsTable, funnelTypesTable } = dbModule;
const routerMod = await import("./drilldown");

// Funnel/source values shared by both tenants (the overlap that makes the
// partition non-trivial: the rows are indistinguishable by funnel/source, only
// by tenant_id).
const FUNNEL_HEAT_PUMP = "Heat Pump";
const FUNNEL_FURNACE = "Furnace";
const SOURCE_GOOGLE = "Google";
const SOURCE_META = "Meta";

// Tenant-distinctive values: each appears for exactly one tenant so leakage is
// directly observable (tenant A must never surface B-only values and vice-versa).
const FUNNEL_A_ONLY = "AOnlyFunnel";
const SOURCE_A_ONLY = "AOnlySource";
const FUNNEL_B_ONLY = "BOnlyFunnel";
const SOURCE_B_ONLY = "BOnlySource";

interface TenantFx {
  tenantId: number;
  funnelHpId: number;
  funnelFrId: number;
  leadIds: number[];
  jobIds: number[];
  // Expected /summary totals for this tenant alone.
  expected: { revenue: number; rebates: number; attributed: number; count: number };
}

let A: TenantFx;
let B: TenantFx;

const START_DATE = "2026-01-01";
const END_DATE = "2026-12-31";
const IN_RANGE = new Date("2026-03-15T12:00:00.000Z");

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
): Promise<{ status: number; json: unknown; headers: http.IncomingHttpHeaders }> {
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
            resolve({
              status: res.statusCode ?? 0,
              json: data ? JSON.parse(data) : null,
              headers: res.headers,
            });
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
  });
}

type ListRow = {
  id: number;
  tenantId: number;
  funnel: string | null;
  source: string | null;
  correctedRevenue: number;
};

/**
 * Seeds one tenant with four completed, in-range jobs:
 *   - Heat Pump / Google (attributed)
 *   - Furnace   / Meta   (not attributed)
 *   - {funnelOnly} / {sourceOnly} (attributed) — tenant-distinctive
 *   - Heat Pump / Google (not attributed)      — shares funnel+source with #1
 * `scale` multiplies the money so the two tenants have clearly different totals.
 */
async function seedTenant(opts: {
  label: string;
  funnelOnly: string;
  sourceOnly: string;
  scale: number;
}): Promise<TenantFx> {
  const slug = `rev-iso-${opts.label}`;
  const [tenant] = await db
    .insert(tenantsTable)
    .values({ name: `Revenue Iso ${slug}`, clientSlug: slug })
    .returning();

  // Same funnel *names* for both tenants but globally-unique slugs: this proves
  // the partition is by tenant_id on the jobs/leads side, not by funnel identity.
  const [funnelHp] = await db
    .insert(funnelTypesTable)
    .values({ name: FUNNEL_HEAT_PUMP, slug: `hp-${slug}` })
    .returning();
  const [funnelFr] = await db
    .insert(funnelTypesTable)
    .values({ name: FUNNEL_FURNACE, slug: `fr-${slug}` })
    .returning();

  const mkLead = async (o: { source: string; funnelId: number | null; leadType: string | null }) => {
    const [lead] = await db
      .insert(leadsTable)
      .values({
        tenantId: tenant.id,
        firstName: "Lead",
        lastName: slug,
        source: o.source,
        originalSource: o.source,
        funnelId: o.funnelId ?? undefined,
        leadType: o.leadType,
      })
      .returning();
    return lead;
  };

  const mkJob = async (o: {
    leadId: number;
    invoiceTotal: number;
    invoiceRebateAmount: number;
    matchLevel: string | null;
  }) => {
    const [job] = await db
      .insert(jobsTable)
      .values({
        tenantId: tenant.id,
        leadId: o.leadId,
        jobType: "hvac",
        jobTypeName: "HVAC",
        status: "completed",
        revenue: o.invoiceTotal,
        invoiceTotal: o.invoiceTotal,
        invoiceRebateAmount: o.invoiceRebateAmount,
        matchLevel: o.matchLevel,
        invoiceDate: IN_RANGE,
      })
      .returning();
    return job;
  };

  const s = opts.scale;
  const leadHp1 = await mkLead({ source: SOURCE_GOOGLE, funnelId: funnelHp.id, leadType: "ignored" });
  const leadFr = await mkLead({ source: SOURCE_META, funnelId: funnelFr.id, leadType: "ignored" });
  const leadOnly = await mkLead({ source: opts.sourceOnly, funnelId: null, leadType: opts.funnelOnly });
  const leadHp2 = await mkLead({ source: SOURCE_GOOGLE, funnelId: funnelHp.id, leadType: "ignored" });

  // Heat Pump / Google — corrected 100s + 10s, attributed.
  const j1 = await mkJob({ leadId: leadHp1.id, invoiceTotal: 100 * s, invoiceRebateAmount: 10 * s, matchLevel: "gclid" });
  // Furnace / Meta — corrected 200s + 20s, NOT attributed.
  const j2 = await mkJob({ leadId: leadFr.id, invoiceTotal: 200 * s, invoiceRebateAmount: 20 * s, matchLevel: null });
  // tenant-only funnel/source — corrected 300s + 0, attributed.
  const j3 = await mkJob({ leadId: leadOnly.id, invoiceTotal: 300 * s, invoiceRebateAmount: 0, matchLevel: "manual" });
  // Heat Pump / Google again — corrected 400s + 40s, NOT attributed.
  const j4 = await mkJob({ leadId: leadHp2.id, invoiceTotal: 400 * s, invoiceRebateAmount: 40 * s, matchLevel: null });

  const corrected = (total: number, rebate: number) => total + rebate;
  const revenue =
    corrected(100 * s, 10 * s) +
    corrected(200 * s, 20 * s) +
    corrected(300 * s, 0) +
    corrected(400 * s, 40 * s);
  const rebates = 10 * s + 20 * s + 0 + 40 * s;
  const attributed = corrected(100 * s, 10 * s) + corrected(300 * s, 0); // j1 + j3

  return {
    tenantId: tenant.id,
    funnelHpId: funnelHp.id,
    funnelFrId: funnelFr.id,
    leadIds: [leadHp1.id, leadFr.id, leadOnly.id, leadHp2.id],
    jobIds: [j1.id, j2.id, j3.id, j4.id],
    expected: { revenue, rebates, attributed, count: 4 },
  };
}

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  A = await seedTenant({ label: "a", funnelOnly: FUNNEL_A_ONLY, sourceOnly: SOURCE_A_ONLY, scale: 1 });
  B = await seedTenant({ label: "b", funnelOnly: FUNNEL_B_ONLY, sourceOnly: SOURCE_B_ONLY, scale: 7 });
});

afterAll(async () => {
  const cleanup = async (fx: TenantFx | undefined) => {
    if (!fx) return;
    try {
      await db.delete(jobsTable).where(inArray(jobsTable.id, fx.jobIds));
      await db.delete(leadsTable).where(inArray(leadsTable.id, fx.leadIds));
      await db.delete(funnelTypesTable).where(inArray(funnelTypesTable.id, [fx.funnelHpId, fx.funnelFrId]));
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
const range = (tenantId: number) =>
  `tenantId=${tenantId}&startDate=${START_DATE}&endDate=${END_DATE}`;

describe("GET /drilldown/revenue-attributed — tenant isolation (real Postgres)", () => {
  it("returns only tenant A's jobs, never tenant B's", async () => {
    const res = await getJson(adminApp(), `/drilldown/revenue-attributed?${range(A.tenantId)}&limit=all`);
    expect(res.status).toBe(200);
    const rows = res.json as ListRow[];

    expect(rows.map((r) => r.id).sort((a, b) => a - b)).toEqual([...A.jobIds].sort((a, b) => a - b));
    // Every row belongs to tenant A; none of B's ids leak in.
    for (const r of rows) expect(r.tenantId).toBe(A.tenantId);
    for (const id of B.jobIds) expect(rows.map((r) => r.id)).not.toContain(id);
    // No row carries a B-only funnel/source value.
    for (const r of rows) {
      expect(r.funnel).not.toBe(FUNNEL_B_ONLY);
      expect(r.source).not.toBe(SOURCE_B_ONLY);
    }
    expect(res.headers["x-total-count"]).toBe("4");
  });

  it("returns only tenant B's jobs, never tenant A's (symmetric)", async () => {
    const res = await getJson(adminApp(), `/drilldown/revenue-attributed?${range(B.tenantId)}&limit=all`);
    expect(res.status).toBe(200);
    const rows = res.json as ListRow[];

    expect(rows.map((r) => r.id).sort((a, b) => a - b)).toEqual([...B.jobIds].sort((a, b) => a - b));
    for (const r of rows) expect(r.tenantId).toBe(B.tenantId);
    for (const id of A.jobIds) expect(rows.map((r) => r.id)).not.toContain(id);
    for (const r of rows) {
      expect(r.funnel).not.toBe(FUNNEL_A_ONLY);
      expect(r.source).not.toBe(SOURCE_A_ONLY);
    }
    expect(res.headers["x-total-count"]).toBe("4");
  });

  it("a shared funnel+source filter still partitions by tenant (Heat Pump + Google)", async () => {
    // Both tenants have Heat Pump / Google jobs; the filter must only surface
    // the requesting tenant's two such jobs, never the other tenant's.
    const filter = `&funnel=${encodeURIComponent(FUNNEL_HEAT_PUMP)}&source=${encodeURIComponent(SOURCE_GOOGLE)}`;
    const resA = await getJson(adminApp(), `/drilldown/revenue-attributed?${range(A.tenantId)}&limit=all${filter}`);
    const rowsA = resA.json as ListRow[];
    expect(rowsA).toHaveLength(2);
    for (const r of rowsA) expect(r.tenantId).toBe(A.tenantId);

    const resB = await getJson(adminApp(), `/drilldown/revenue-attributed?${range(B.tenantId)}&limit=all${filter}`);
    const rowsB = resB.json as ListRow[];
    expect(rowsB).toHaveLength(2);
    for (const r of rowsB) expect(r.tenantId).toBe(B.tenantId);

    // The two result sets are disjoint.
    const idsA = new Set(rowsA.map((r) => r.id));
    for (const r of rowsB) expect(idsA.has(r.id)).toBe(false);
  });
});

describe("GET /drilldown/revenue-attributed/summary — tenant isolation (real Postgres)", () => {
  it("totals only tenant A's jobs", async () => {
    const res = await getJson(adminApp(), `/drilldown/revenue-attributed/summary?${range(A.tenantId)}`);
    expect(res.status).toBe(200);
    expect(res.json).toEqual(A.expected);
  });

  it("totals only tenant B's jobs", async () => {
    const res = await getJson(adminApp(), `/drilldown/revenue-attributed/summary?${range(B.tenantId)}`);
    expect(res.status).toBe(200);
    expect(res.json).toEqual(B.expected);
  });

  it("neither tenant's totals include the other (no cross-tenant bleed)", async () => {
    const resA = await getJson(adminApp(), `/drilldown/revenue-attributed/summary?${range(A.tenantId)}`);
    const sumA = resA.json as { revenue: number; count: number };
    // A's count/revenue match A alone; the combined two-tenant figure would be
    // strictly larger, so equality here proves B did not bleed in.
    expect(sumA.count).toBe(A.expected.count);
    expect(sumA.revenue).toBe(A.expected.revenue);
    expect(sumA.revenue).not.toBe(A.expected.revenue + B.expected.revenue);
  });
});

describe("GET /drilldown/revenue-attributed/facets — tenant isolation (real Postgres)", () => {
  it("offers only tenant A's distinct funnels/sources", async () => {
    const res = await getJson(adminApp(), `/drilldown/revenue-attributed/facets?${range(A.tenantId)}`);
    expect(res.status).toBe(200);
    const { funnels, sources } = res.json as { funnels: string[]; sources: string[] };

    expect(funnels).toEqual([FUNNEL_A_ONLY, FUNNEL_FURNACE, FUNNEL_HEAT_PUMP]);
    expect(sources).toEqual([SOURCE_A_ONLY, SOURCE_GOOGLE, SOURCE_META]);
    expect(funnels).not.toContain(FUNNEL_B_ONLY);
    expect(sources).not.toContain(SOURCE_B_ONLY);
  });

  it("offers only tenant B's distinct funnels/sources", async () => {
    const res = await getJson(adminApp(), `/drilldown/revenue-attributed/facets?${range(B.tenantId)}`);
    expect(res.status).toBe(200);
    const { funnels, sources } = res.json as { funnels: string[]; sources: string[] };

    expect(funnels).toEqual([FUNNEL_B_ONLY, FUNNEL_FURNACE, FUNNEL_HEAT_PUMP]);
    expect(sources).toEqual([SOURCE_B_ONLY, SOURCE_GOOGLE, SOURCE_META]);
    expect(funnels).not.toContain(FUNNEL_A_ONLY);
    expect(sources).not.toContain(SOURCE_A_ONLY);
  });
});

describe("Revenue Attributed — a tenant-scoped role cannot widen scope via query.tenantId (real Postgres)", () => {
  // client_admin pinned to tenant A, but every request tries to target tenant B
  // through query.tenantId. resolveListTenantScope must force the session tenant.
  const scopedToA = () => makeApp({ userRole: "client_admin", tenantId: A.tenantId });

  it("list ignores query.tenantId=B and returns only tenant A's jobs", async () => {
    const res = await getJson(scopedToA(), `/drilldown/revenue-attributed?${range(B.tenantId)}&limit=all`);
    expect(res.status).toBe(200);
    const rows = res.json as ListRow[];

    expect(rows.map((r) => r.id).sort((a, b) => a - b)).toEqual([...A.jobIds].sort((a, b) => a - b));
    for (const r of rows) expect(r.tenantId).toBe(A.tenantId);
    for (const id of B.jobIds) expect(rows.map((r) => r.id)).not.toContain(id);
    expect(res.headers["x-total-count"]).toBe("4");
  });

  it("summary ignores query.tenantId=B and totals only tenant A's jobs", async () => {
    const res = await getJson(scopedToA(), `/drilldown/revenue-attributed/summary?${range(B.tenantId)}`);
    expect(res.status).toBe(200);
    expect(res.json).toEqual(A.expected);
  });

  it("facets ignore query.tenantId=B and offer only tenant A's values", async () => {
    const res = await getJson(scopedToA(), `/drilldown/revenue-attributed/facets?${range(B.tenantId)}`);
    expect(res.status).toBe(200);
    const { funnels, sources } = res.json as { funnels: string[]; sources: string[] };

    expect(funnels).toEqual([FUNNEL_A_ONLY, FUNNEL_FURNACE, FUNNEL_HEAT_PUMP]);
    expect(sources).toEqual([SOURCE_A_ONLY, SOURCE_GOOGLE, SOURCE_META]);
    expect(funnels).not.toContain(FUNNEL_B_ONLY);
    expect(sources).not.toContain(SOURCE_B_ONLY);
  });

  it("a tenant-scoped role with NO session tenant is denied (cannot fall back to unscoped)", async () => {
    // A broken account (tenant-scoped role, no session tenant) must get a 403
    // rather than an unscoped query that would leak every tenant's rows.
    const brokenApp = makeApp({ userRole: "client_admin", tenantId: null });
    const res = await getJson(brokenApp, `/drilldown/revenue-attributed?${range(A.tenantId)}&limit=all`);
    expect(res.status).toBe(403);
    expect((res.json as { error: string }).error).toBe("No tenant assigned");
  });
});
