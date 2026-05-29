/**
 * Real-Postgres integration coverage for the funnel/source filtering,
 * facets, and sorting contract of the Revenue Attributed drilldown:
 *
 *   GET /drilldown/revenue-attributed
 *   GET /drilldown/revenue-attributed/summary
 *   GET /drilldown/revenue-attributed/facets
 *
 * The sibling unit test (`drilldown-revenue-attributed.test.ts`) mocks the
 * db, so it can only prove the route *wires up* the right params/expressions.
 * It cannot prove the SQL those expressions compile to returns the correct
 * rows/order against Postgres. In particular the mocks cannot exercise:
 *   - the funnel COALESCE(funnel_types.name, leads.lead_type) expression that
 *     drives the Funnel column, the funnel filter, and funnel sorting
 *   - the leftJoin(leads)/leftJoin(funnel_types) that funnel/source filters
 *     and sorts reference
 *   - asc/desc ORDER BY on the funnel + source expressions
 *   - the distinct, status/date-scoped facet lists
 *
 * This file seeds completed jobs + leads + funnel types spanning multiple
 * funnels/sources and asserts the live SQL returns the right rows, totals,
 * facets, and ordering.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import express, { type Request, type Response, type NextFunction } from "express";
import http from "http";

const dbModule = await import("@workspace/db");
const { db, tenantsTable, leadsTable, jobsTable, funnelTypesTable } = dbModule;
const routerMod = await import("./drilldown");

// Funnel names + the leadType fallback are chosen so the canonical funnel
// name (COALESCE(funnel_types.name, leads.lead_type)) sorts in a known order:
//   Furnace < Heat Pump < Roofing  (Roofing comes only from the leadType
//   fallback, proving the COALESCE branch when funnelId is null).
const FUNNEL_HEAT_PUMP = "Heat Pump";
const FUNNEL_FURNACE = "Furnace";
const FUNNEL_ROOFING_FALLBACK = "Roofing"; // leadType-only, no funnel_types row
const SOURCE_GOOGLE = "Google";
const SOURCE_META = "Meta";

interface Fx {
  tenantId: number;
  funnelHpId: number;
  funnelFrId: number;
  leadIds: number[];
  // Completed, in-range jobs we assert against.
  J1: number; // Heat Pump / Google, attributed (matchLevel set)
  J2: number; // Furnace   / Meta,   not attributed
  J3: number; // Roofing(fallback) / Meta, attributed
  J4: number; // Heat Pump / Google, not attributed
  // Noise rows that every filter/facet/summary must exclude.
  J_PENDING: number; // in range but status != completed
  J_OUT_OF_RANGE: number; // completed but outside the date window
}

let fx: Fx;
let app: express.Express;

const START_DATE = "2026-01-01";
const END_DATE = "2026-12-31";
const IN_RANGE = new Date("2026-03-15T12:00:00.000Z");
const OUT_OF_RANGE = new Date("2025-06-01T12:00:00.000Z");

function makeApp(): express.Express {
  const a = express();
  a.use(express.json());
  // super_admin with no session tenant → scope comes from query.tenantId,
  // letting us target exactly the tenant we seed.
  a.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { session: Record<string, unknown> }).session = {
      userId: 1,
      userRole: "super_admin",
      tenantId: null,
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
  funnel: string | null;
  source: string | null;
  correctedRevenue: number;
};

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  const slug = `rev-attr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const [tenant] = await db
    .insert(tenantsTable)
    .values({ name: `Revenue Attr Int ${slug}`, clientSlug: slug })
    .returning();

  // Two real funnel types (authoritative name source). Slugs are globally
  // unique so we scope them with the run marker.
  const [funnelHp] = await db
    .insert(funnelTypesTable)
    .values({ name: FUNNEL_HEAT_PUMP, slug: `hp-${slug}` })
    .returning();
  const [funnelFr] = await db
    .insert(funnelTypesTable)
    .values({ name: FUNNEL_FURNACE, slug: `fr-${slug}` })
    .returning();

  const mkLead = async (opts: {
    source: string;
    funnelId: number | null;
    leadType: string | null;
    assignedTo?: string | null;
  }) => {
    const [lead] = await db
      .insert(leadsTable)
      .values({
        tenantId: tenant.id,
        firstName: "Lead",
        lastName: slug,
        source: opts.source,
        originalSource: opts.source,
        funnelId: opts.funnelId ?? undefined,
        leadType: opts.leadType,
        assignedTo: opts.assignedTo ?? null,
      })
      .returning();
    return lead;
  };

  // Lead A: Heat Pump (via funnelId) / Google
  const leadA = await mkLead({ source: SOURCE_GOOGLE, funnelId: funnelHp.id, leadType: "ignored-A" });
  // Lead B: Furnace (via funnelId) / Meta
  const leadB = await mkLead({ source: SOURCE_META, funnelId: funnelFr.id, leadType: "ignored-B" });
  // Lead C: no funnelId → funnel name falls back to leadType "Roofing" / Meta
  const leadC = await mkLead({ source: SOURCE_META, funnelId: null, leadType: FUNNEL_ROOFING_FALLBACK });
  // Lead D: Heat Pump (via funnelId) / Google — shares funnel+source with A
  const leadD = await mkLead({ source: SOURCE_GOOGLE, funnelId: funnelHp.id, leadType: "ignored-D" });
  // Lead E: noise — only attached to the out-of-range job. Distinct
  // funnel/source so the facet/date exclusion is observable.
  const leadE = await mkLead({ source: "ExcludedSource", funnelId: null, leadType: "ExcludedFunnel" });
  // Lead F: noise — only attached to the pending (non-completed) job.
  const leadF = await mkLead({ source: "PendingSource", funnelId: null, leadType: "PendingFunnel" });

  const mkJob = async (opts: {
    leadId: number;
    invoiceTotal: number | null;
    invoiceRebateAmount: number | null;
    revenue: number;
    matchLevel: string | null;
    status: "completed" | "pending";
    invoiceDate: Date;
  }) => {
    const [job] = await db
      .insert(jobsTable)
      .values({
        tenantId: tenant.id,
        leadId: opts.leadId,
        jobType: "hvac",
        jobTypeName: "HVAC",
        status: opts.status,
        revenue: opts.revenue,
        invoiceTotal: opts.invoiceTotal,
        invoiceRebateAmount: opts.invoiceRebateAmount,
        matchLevel: opts.matchLevel,
        invoiceDate: opts.invoiceDate,
      })
      .returning();
    return job;
  };

  // J1: Heat Pump / Google — corrected 1000+100 = 1100, attributed
  const j1 = await mkJob({ leadId: leadA.id, invoiceTotal: 1000, invoiceRebateAmount: 100, revenue: 999, matchLevel: "gclid", status: "completed", invoiceDate: IN_RANGE });
  // J2: Furnace / Meta — corrected 500+50 = 550, NOT attributed
  const j2 = await mkJob({ leadId: leadB.id, invoiceTotal: 500, invoiceRebateAmount: 50, revenue: 499, matchLevel: null, status: "completed", invoiceDate: IN_RANGE });
  // J3: Roofing(fallback) / Meta — invoiceTotal null → corrected = revenue 750, attributed
  const j3 = await mkJob({ leadId: leadC.id, invoiceTotal: null, invoiceRebateAmount: null, revenue: 750, matchLevel: "manual", status: "completed", invoiceDate: IN_RANGE });
  // J4: Heat Pump / Google — corrected 2000+200 = 2200, NOT attributed
  const j4 = await mkJob({ leadId: leadD.id, invoiceTotal: 2000, invoiceRebateAmount: 200, revenue: 1999, matchLevel: null, status: "completed", invoiceDate: IN_RANGE });
  // Noise: pending (excluded by status filter), in range.
  const jPending = await mkJob({ leadId: leadF.id, invoiceTotal: 9999, invoiceRebateAmount: 0, revenue: 9999, matchLevel: "gclid", status: "pending", invoiceDate: IN_RANGE });
  // Noise: completed but outside the date window.
  const jOut = await mkJob({ leadId: leadE.id, invoiceTotal: 8888, invoiceRebateAmount: 0, revenue: 8888, matchLevel: "gclid", status: "completed", invoiceDate: OUT_OF_RANGE });

  fx = {
    tenantId: tenant.id,
    funnelHpId: funnelHp.id,
    funnelFrId: funnelFr.id,
    leadIds: [leadA.id, leadB.id, leadC.id, leadD.id, leadE.id, leadF.id],
    J1: j1.id,
    J2: j2.id,
    J3: j3.id,
    J4: j4.id,
    J_PENDING: jPending.id,
    J_OUT_OF_RANGE: jOut.id,
  };
  app = makeApp();
});

afterAll(async () => {
  if (!fx) return;
  const jobIds = [fx.J1, fx.J2, fx.J3, fx.J4, fx.J_PENDING, fx.J_OUT_OF_RANGE];
  try {
    await db.delete(jobsTable).where(inArray(jobsTable.id, jobIds));
    await db.delete(leadsTable).where(inArray(leadsTable.id, fx.leadIds));
    await db.delete(funnelTypesTable).where(inArray(funnelTypesTable.id, [fx.funnelHpId, fx.funnelFrId]));
    await db.delete(tenantsTable).where(eq(tenantsTable.id, fx.tenantId));
  } catch {
    /* best-effort cleanup */
  }
  vi.restoreAllMocks();
});

const range = () => `tenantId=${fx.tenantId}&startDate=${START_DATE}&endDate=${END_DATE}`;

describe("GET /drilldown/revenue-attributed — funnel/source filtering (real Postgres)", () => {
  it("returns every completed in-range job when no funnel/source filter is applied", async () => {
    const res = await getJson(app, `/drilldown/revenue-attributed?${range()}&limit=all`);
    expect(res.status).toBe(200);
    const ids = (res.json as ListRow[]).map((r) => r.id).sort((a, b) => a - b);
    // J1-J4 only: the pending + out-of-range jobs are excluded by the
    // status="completed" and date predicates.
    expect(ids).toEqual([fx.J1, fx.J2, fx.J3, fx.J4].sort((a, b) => a - b));
    expect(res.headers["x-total-count"]).toBe("4");
  });

  it("filters to a funnel resolved via funnel_types.name (Heat Pump → J1 + J4)", async () => {
    const res = await getJson(app, `/drilldown/revenue-attributed?${range()}&limit=all&funnel=${encodeURIComponent(FUNNEL_HEAT_PUMP)}`);
    expect(res.status).toBe(200);
    const rows = res.json as ListRow[];
    expect(rows.map((r) => r.id).sort((a, b) => a - b)).toEqual([fx.J1, fx.J4].sort((a, b) => a - b));
    for (const r of rows) expect(r.funnel).toBe(FUNNEL_HEAT_PUMP);
    // Count header tracks the filter, not the unfiltered total.
    expect(res.headers["x-total-count"]).toBe("2");
  });

  it("filters to a funnel resolved via the leads.lead_type fallback (Roofing → J3)", async () => {
    const res = await getJson(app, `/drilldown/revenue-attributed?${range()}&limit=all&funnel=${encodeURIComponent(FUNNEL_ROOFING_FALLBACK)}`);
    expect(res.status).toBe(200);
    const rows = res.json as ListRow[];
    expect(rows.map((r) => r.id)).toEqual([fx.J3]);
    expect(rows[0].funnel).toBe(FUNNEL_ROOFING_FALLBACK);
  });

  it("filters by lead source (Meta → J2 + J3)", async () => {
    const res = await getJson(app, `/drilldown/revenue-attributed?${range()}&limit=all&source=${encodeURIComponent(SOURCE_META)}`);
    expect(res.status).toBe(200);
    const rows = res.json as ListRow[];
    expect(rows.map((r) => r.id).sort((a, b) => a - b)).toEqual([fx.J2, fx.J3].sort((a, b) => a - b));
    for (const r of rows) expect(r.source).toBe(SOURCE_META);
  });

  it("combines funnel + source filters (Heat Pump + Google → J1 + J4; Heat Pump + Meta → none)", async () => {
    const hit = await getJson(app, `/drilldown/revenue-attributed?${range()}&limit=all&funnel=${encodeURIComponent(FUNNEL_HEAT_PUMP)}&source=${encodeURIComponent(SOURCE_GOOGLE)}`);
    expect(hit.status).toBe(200);
    expect((hit.json as ListRow[]).map((r) => r.id).sort((a, b) => a - b)).toEqual([fx.J1, fx.J4].sort((a, b) => a - b));

    const miss = await getJson(app, `/drilldown/revenue-attributed?${range()}&limit=all&funnel=${encodeURIComponent(FUNNEL_HEAT_PUMP)}&source=${encodeURIComponent(SOURCE_META)}`);
    expect(miss.status).toBe(200);
    expect((miss.json as ListRow[]).map((r) => r.id)).toEqual([]);
    expect(miss.headers["x-total-count"]).toBe("0");
  });
});

describe("GET /drilldown/revenue-attributed — asc/desc sorting (real Postgres)", () => {
  const funnelsOf = (rows: ListRow[]) => rows.map((r) => r.funnel as string);
  const sourcesOf = (rows: ListRow[]) => rows.map((r) => r.source as string);
  const isSortedAsc = (xs: string[]) => xs.every((v, i) => i === 0 || xs[i - 1].localeCompare(v) <= 0);
  const isSortedDesc = (xs: string[]) => xs.every((v, i) => i === 0 || xs[i - 1].localeCompare(v) >= 0);

  it("sorts by funnel ascending using real SQL ORDER BY on the COALESCE expression", async () => {
    const res = await getJson(app, `/drilldown/revenue-attributed?${range()}&limit=all&sort=funnel&dir=asc`);
    expect(res.status).toBe(200);
    const funnels = funnelsOf(res.json as ListRow[]);
    // Furnace, Heat Pump, Heat Pump, Roofing
    expect(funnels).toHaveLength(4);
    expect(funnels[0]).toBe(FUNNEL_FURNACE);
    expect(funnels[funnels.length - 1]).toBe(FUNNEL_ROOFING_FALLBACK);
    expect(isSortedAsc(funnels)).toBe(true);
  });

  it("sorts by funnel descending using real SQL ORDER BY on the COALESCE expression", async () => {
    const res = await getJson(app, `/drilldown/revenue-attributed?${range()}&limit=all&sort=funnel&dir=desc`);
    expect(res.status).toBe(200);
    const funnels = funnelsOf(res.json as ListRow[]);
    expect(funnels).toHaveLength(4);
    expect(funnels[0]).toBe(FUNNEL_ROOFING_FALLBACK);
    expect(funnels[funnels.length - 1]).toBe(FUNNEL_FURNACE);
    expect(isSortedDesc(funnels)).toBe(true);
  });

  it("sorts by source ascending using real SQL ORDER BY on leads.source", async () => {
    const res = await getJson(app, `/drilldown/revenue-attributed?${range()}&limit=all&sort=source&dir=asc`);
    expect(res.status).toBe(200);
    const sources = sourcesOf(res.json as ListRow[]);
    // Google, Google, Meta, Meta
    expect(sources).toHaveLength(4);
    expect(sources[0]).toBe(SOURCE_GOOGLE);
    expect(sources[sources.length - 1]).toBe(SOURCE_META);
    expect(isSortedAsc(sources)).toBe(true);
  });

  it("sorts by source descending using real SQL ORDER BY on leads.source", async () => {
    const res = await getJson(app, `/drilldown/revenue-attributed?${range()}&limit=all&sort=source&dir=desc`);
    expect(res.status).toBe(200);
    const sources = sourcesOf(res.json as ListRow[]);
    expect(sources).toHaveLength(4);
    expect(sources[0]).toBe(SOURCE_META);
    expect(sources[sources.length - 1]).toBe(SOURCE_GOOGLE);
    expect(isSortedDesc(sources)).toBe(true);
  });
});

describe("GET /drilldown/revenue-attributed/summary — filtered totals (real Postgres)", () => {
  it("totals every completed in-range job with no filter", async () => {
    const res = await getJson(app, `/drilldown/revenue-attributed/summary?${range()}`);
    expect(res.status).toBe(200);
    // revenue = 1100 + 550 + 750 + 2200 = 4600
    // rebates = 100 + 50 + 0 + 200 = 350
    // attributed = J1 (1100) + J3 (750) = 1850 (J2, J4 have null matchLevel)
    expect(res.json).toEqual({ revenue: 4600, rebates: 350, attributed: 1850, count: 4 });
  });

  it("scopes the totals to a funnel filter (Heat Pump → J1 + J4)", async () => {
    const res = await getJson(app, `/drilldown/revenue-attributed/summary?${range()}&funnel=${encodeURIComponent(FUNNEL_HEAT_PUMP)}`);
    expect(res.status).toBe(200);
    // J1 corrected 1100 (attributed) + J4 corrected 2200 (not attributed)
    expect(res.json).toEqual({ revenue: 3300, rebates: 300, attributed: 1100, count: 2 });
  });

  it("scopes the totals to a source filter (Meta → J2 + J3)", async () => {
    const res = await getJson(app, `/drilldown/revenue-attributed/summary?${range()}&source=${encodeURIComponent(SOURCE_META)}`);
    expect(res.status).toBe(200);
    // J2 corrected 550 (not attributed) + J3 corrected 750 (attributed)
    expect(res.json).toEqual({ revenue: 1300, rebates: 50, attributed: 750, count: 2 });
  });

  it("summary totals reconcile with the sum of the filtered list rows (Heat Pump)", async () => {
    const listRes = await getJson(app, `/drilldown/revenue-attributed?${range()}&limit=all&funnel=${encodeURIComponent(FUNNEL_HEAT_PUMP)}`);
    const summaryRes = await getJson(app, `/drilldown/revenue-attributed/summary?${range()}&funnel=${encodeURIComponent(FUNNEL_HEAT_PUMP)}`);
    const rows = listRes.json as ListRow[];
    const listRevenue = Math.round(rows.reduce((s, r) => s + r.correctedRevenue, 0) * 100) / 100;
    const summary = summaryRes.json as { revenue: number; count: number };
    expect(summary.count).toBe(rows.length);
    expect(summary.revenue).toBe(listRevenue);
  });
});

describe("GET /drilldown/revenue-attributed/facets — distinct sorted values (real Postgres)", () => {
  it("returns the distinct funnels + sources across completed in-range jobs, sorted, excluding pending/out-of-range noise", async () => {
    const res = await getJson(app, `/drilldown/revenue-attributed/facets?${range()}`);
    expect(res.status).toBe(200);
    const { funnels, sources } = res.json as { funnels: string[]; sources: string[] };

    // Only the funnels/sources of J1-J4 appear, alphabetically sorted. The
    // pending job's funnel/source ("PendingFunnel"/"PendingSource") and the
    // out-of-range job's ("ExcludedFunnel"/"ExcludedSource") must be absent.
    expect(funnels).toEqual([FUNNEL_FURNACE, FUNNEL_HEAT_PUMP, FUNNEL_ROOFING_FALLBACK]);
    expect(sources).toEqual([SOURCE_GOOGLE, SOURCE_META]);

    expect(funnels).not.toContain("PendingFunnel");
    expect(funnels).not.toContain("ExcludedFunnel");
    expect(sources).not.toContain("PendingSource");
    expect(sources).not.toContain("ExcludedSource");
  });
});
