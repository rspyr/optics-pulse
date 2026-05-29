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

// ---------------------------------------------------------------------------
// Paging (limit/offset) against real Postgres.
//
// The filtering/sorting tests above always pull with `limit=all`, so the
// route's limit/offset paging path — and the X-Total-Count header staying
// constant across pages — is only ever exercised with the db mocked. A
// SQL-level paging regression (an ORDER BY that isn't stable under
// LIMIT/OFFSET, or an offset applied to the wrong query) would slip past them.
//
// This block seeds its own tenant with enough completed jobs to span multiple
// pages under a fixed sort, with *distinct* corrected revenues so the default
// `revenue desc` ORDER BY is fully deterministic. It then walks the pages and
// asserts they are disjoint, correctly-ordered slices of the full list and
// that X-Total-Count reflects the full *filtered* total on every page.
// ---------------------------------------------------------------------------
interface PageFx {
  tenantId: number;
  leadIds: number[];
  jobIds: number[];
  // Completed, in-range jobs ordered by corrected revenue DESC (5000→1000).
  // P1-P3 are Google, P4-P5 are Meta, so a source filter narrows the total.
  orderedDesc: number[]; // [P1, P2, P3, P4, P5]
  googleDesc: number[]; // [P1, P2, P3]
}

let pageFx: PageFx;

beforeAll(async () => {
  const slug = `rev-attr-page-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const [tenant] = await db
    .insert(tenantsTable)
    .values({ name: `Revenue Attr Paging ${slug}`, clientSlug: slug })
    .returning();

  const mkLead = async (source: string) => {
    const [lead] = await db
      .insert(leadsTable)
      .values({
        tenantId: tenant.id,
        firstName: "Page",
        lastName: slug,
        source,
        originalSource: source,
        leadType: "PagingFunnel",
      })
      .returning();
    return lead;
  };

  const mkJob = async (opts: {
    leadId: number;
    corrected: number;
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
        // invoiceRebateAmount 0 → corrected revenue == invoiceTotal, so each
        // job has the exact distinct corrected revenue we control here.
        revenue: opts.corrected,
        invoiceTotal: opts.corrected,
        invoiceRebateAmount: 0,
        matchLevel: "gclid",
        invoiceDate: opts.invoiceDate,
      })
      .returning();
    return job;
  };

  // Five completed, in-range jobs with distinct corrected revenues. Sources
  // are split (3 Google / 2 Meta) so a source filter changes the total.
  const specs: { source: string; corrected: number }[] = [
    { source: SOURCE_GOOGLE, corrected: 5000 },
    { source: SOURCE_GOOGLE, corrected: 4000 },
    { source: SOURCE_GOOGLE, corrected: 3000 },
    { source: SOURCE_META, corrected: 2000 },
    { source: SOURCE_META, corrected: 1000 },
  ];

  const leadIds: number[] = [];
  const orderedDesc: number[] = [];
  const googleDesc: number[] = [];
  for (const spec of specs) {
    const lead = await mkLead(spec.source);
    leadIds.push(lead.id);
    const job = await mkJob({
      leadId: lead.id,
      corrected: spec.corrected,
      status: "completed",
      invoiceDate: IN_RANGE,
    });
    orderedDesc.push(job.id);
    if (spec.source === SOURCE_GOOGLE) googleDesc.push(job.id);
  }

  // Noise the total must never include: a pending (non-completed) job and a
  // completed-but-out-of-range job. Both would inflate X-Total-Count if the
  // count query dropped the status/date predicates.
  const noiseLeadPending = await mkLead("NoiseSource");
  const noiseLeadOut = await mkLead("NoiseSource");
  const jobPending = await mkJob({ leadId: noiseLeadPending.id, corrected: 9999, status: "pending", invoiceDate: IN_RANGE });
  const jobOut = await mkJob({ leadId: noiseLeadOut.id, corrected: 8888, status: "completed", invoiceDate: OUT_OF_RANGE });

  pageFx = {
    tenantId: tenant.id,
    leadIds: [...leadIds, noiseLeadPending.id, noiseLeadOut.id],
    jobIds: [...orderedDesc, jobPending.id, jobOut.id],
    orderedDesc,
    googleDesc,
  };
});

afterAll(async () => {
  if (!pageFx) return;
  try {
    await db.delete(jobsTable).where(inArray(jobsTable.id, pageFx.jobIds));
    await db.delete(leadsTable).where(inArray(leadsTable.id, pageFx.leadIds));
    await db.delete(tenantsTable).where(eq(tenantsTable.id, pageFx.tenantId));
  } catch {
    /* best-effort cleanup */
  }
});

describe("GET /drilldown/revenue-attributed — limit/offset paging (real Postgres)", () => {
  const pageRange = () =>
    `tenantId=${pageFx.tenantId}&startDate=${START_DATE}&endDate=${END_DATE}`;

  it("returns the full ordered list when unpaged (revenue desc, distinct values)", async () => {
    const res = await getJson(app, `/drilldown/revenue-attributed?${pageRange()}&limit=all&sort=revenue&dir=desc`);
    expect(res.status).toBe(200);
    const ids = (res.json as ListRow[]).map((r) => r.id);
    expect(ids).toEqual(pageFx.orderedDesc);
    // Total reflects only the 5 completed in-range jobs (noise excluded).
    expect(res.headers["x-total-count"]).toBe("5");
  });

  it("returns disjoint, correctly-ordered pages that reassemble the full list", async () => {
    const page1 = await getJson(app, `/drilldown/revenue-attributed?${pageRange()}&sort=revenue&dir=desc&limit=2&offset=0`);
    const page2 = await getJson(app, `/drilldown/revenue-attributed?${pageRange()}&sort=revenue&dir=desc&limit=2&offset=2`);
    const page3 = await getJson(app, `/drilldown/revenue-attributed?${pageRange()}&sort=revenue&dir=desc&limit=2&offset=4`);

    expect(page1.status).toBe(200);
    expect(page2.status).toBe(200);
    expect(page3.status).toBe(200);

    const ids1 = (page1.json as ListRow[]).map((r) => r.id);
    const ids2 = (page2.json as ListRow[]).map((r) => r.id);
    const ids3 = (page3.json as ListRow[]).map((r) => r.id);

    // Each page is the expected slice of the fixed revenue-desc ordering.
    expect(ids1).toEqual(pageFx.orderedDesc.slice(0, 2));
    expect(ids2).toEqual(pageFx.orderedDesc.slice(2, 4));
    expect(ids3).toEqual(pageFx.orderedDesc.slice(4, 6));

    // Pages are disjoint and reassemble the full ordered list in order — this
    // is what fails if OFFSET is applied to the wrong query or the ORDER BY
    // isn't stable under LIMIT/OFFSET.
    const reassembled = [...ids1, ...ids2, ...ids3];
    expect(reassembled).toEqual(pageFx.orderedDesc);
    expect(new Set(reassembled).size).toBe(reassembled.length);

    // X-Total-Count is the full filtered total on every page, not the page size.
    expect(page1.headers["x-total-count"]).toBe("5");
    expect(page2.headers["x-total-count"]).toBe("5");
    expect(page3.headers["x-total-count"]).toBe("5");
  });

  it("pages an ascending sort the same way (mirror of the desc walk)", async () => {
    const orderedAsc = [...pageFx.orderedDesc].reverse();
    const page1 = await getJson(app, `/drilldown/revenue-attributed?${pageRange()}&sort=revenue&dir=asc&limit=2&offset=0`);
    const page2 = await getJson(app, `/drilldown/revenue-attributed?${pageRange()}&sort=revenue&dir=asc&limit=2&offset=2`);

    expect(page1.status).toBe(200);
    expect(page2.status).toBe(200);
    expect((page1.json as ListRow[]).map((r) => r.id)).toEqual(orderedAsc.slice(0, 2));
    expect((page2.json as ListRow[]).map((r) => r.id)).toEqual(orderedAsc.slice(2, 4));
  });

  it("keeps X-Total-Count at the FILTERED total across pages of a filtered list", async () => {
    // Google → 3 jobs (P1-P3). Paging one at a time must report total=3 on
    // every page, proving the count query carries the same source filter.
    const page1 = await getJson(app, `/drilldown/revenue-attributed?${pageRange()}&sort=revenue&dir=desc&source=${encodeURIComponent(SOURCE_GOOGLE)}&limit=1&offset=0`);
    const page2 = await getJson(app, `/drilldown/revenue-attributed?${pageRange()}&sort=revenue&dir=desc&source=${encodeURIComponent(SOURCE_GOOGLE)}&limit=1&offset=1`);
    const page3 = await getJson(app, `/drilldown/revenue-attributed?${pageRange()}&sort=revenue&dir=desc&source=${encodeURIComponent(SOURCE_GOOGLE)}&limit=1&offset=2`);

    expect((page1.json as ListRow[]).map((r) => r.id)).toEqual([pageFx.googleDesc[0]]);
    expect((page2.json as ListRow[]).map((r) => r.id)).toEqual([pageFx.googleDesc[1]]);
    expect((page3.json as ListRow[]).map((r) => r.id)).toEqual([pageFx.googleDesc[2]]);

    expect(page1.headers["x-total-count"]).toBe("3");
    expect(page2.headers["x-total-count"]).toBe("3");
    expect(page3.headers["x-total-count"]).toBe("3");

    // A page past the end is empty but still reports the filtered total.
    const past = await getJson(app, `/drilldown/revenue-attributed?${pageRange()}&sort=revenue&dir=desc&source=${encodeURIComponent(SOURCE_GOOGLE)}&limit=1&offset=3`);
    expect((past.json as ListRow[])).toEqual([]);
    expect(past.headers["x-total-count"]).toBe("3");
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

// ---------------------------------------------------------------------------
// Stable paging for the TEXT (customer) and DATE sorts against real Postgres.
//
// The revenue paging block above leans on *distinct* numeric revenues, so its
// ORDER BY is total on its own and LIMIT/OFFSET can't misbehave. sort=customer
// and sort=date are the dangerous cases: customer names and invoice dates tie
// constantly, and Postgres gives no guaranteed order among rows the ORDER BY
// can't tell apart. Without a unique tiebreaker, two adjacent pages can serve
// the same tied row twice (overlap) or drop one entirely (skip) — the classic
// LIMIT/OFFSET-on-a-non-unique-sort bug.
//
// This block seeds a fresh tenant with *tied* customer names AND *tied* invoice
// dates, deliberately arranged so a tied group straddles a page boundary, then
// walks the pages under sort=customer and sort=date (asc + desc). It asserts
// every page is a disjoint, correctly-ordered slice of the route's own full
// (limit=all) ordering, that the pages reassemble that full list with no
// overlap and no skips, and that the full list matches the intended total order
// (primary key, then jobs.id as the tiebreaker). That total order is exactly
// what the route's id tiebreaker guarantees; remove it and these fail.
// ---------------------------------------------------------------------------
interface SortRow {
  id: number;
  customerName: string;
  invoiceDateMs: number;
}
interface SortFx {
  tenantId: number;
  leadId: number;
  jobIds: number[];
  rows: SortRow[]; // in insertion order → id ascending
}

let sortFx: SortFx;

// Two tied customer names (sort A < B under any reasonable collation) and two
// tied invoice dates, both in range. Each (name,date) combo repeats so both the
// customer sort and the date sort have ties that span page boundaries.
const CUST_A = "Acme";
const CUST_B = "Beacon";
const DATE_EARLY = new Date("2026-03-10T12:00:00.000Z");
const DATE_LATE = new Date("2026-03-20T12:00:00.000Z");

beforeAll(async () => {
  const slug = `rev-attr-sort-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const [tenant] = await db
    .insert(tenantsTable)
    .values({ name: `Revenue Attr Sort ${slug}`, clientSlug: slug })
    .returning();

  // One shared lead is enough — the customer/date sorts read jobs columns, not
  // the lead. (A lead is still needed so the left-join resolves source/funnel.)
  const [lead] = await db
    .insert(leadsTable)
    .values({
      tenantId: tenant.id,
      firstName: "Sort",
      lastName: slug,
      source: SOURCE_GOOGLE,
      originalSource: SOURCE_GOOGLE,
      leadType: "SortFunnel",
    })
    .returning();

  const mkJob = async (customerName: string, invoiceDate: Date) => {
    const [job] = await db
      .insert(jobsTable)
      .values({
        tenantId: tenant.id,
        leadId: lead.id,
        jobType: "hvac",
        jobTypeName: "HVAC",
        status: "completed",
        revenue: 1000,
        invoiceTotal: 1000,
        invoiceRebateAmount: 0,
        matchLevel: "gclid",
        customerName,
        invoiceDate,
      })
      .returning();
    return job;
  };

  // Insertion order fixes id ascending (serial). The arrangement gives:
  //   - customer ties: Acme ×3, Beacon ×3
  //   - date ties: DATE_EARLY on rows 1,3,5; DATE_LATE on rows 2,4,6
  // With limit=2 a tied group straddles a page boundary under both sorts.
  const specs: { name: string; date: Date }[] = [
    { name: CUST_A, date: DATE_EARLY },
    { name: CUST_A, date: DATE_LATE },
    { name: CUST_A, date: DATE_EARLY },
    { name: CUST_B, date: DATE_LATE },
    { name: CUST_B, date: DATE_EARLY },
    { name: CUST_B, date: DATE_LATE },
  ];

  const rows: SortRow[] = [];
  for (const spec of specs) {
    const job = await mkJob(spec.name, spec.date);
    rows.push({ id: job.id, customerName: spec.name, invoiceDateMs: spec.date.getTime() });
  }

  sortFx = {
    tenantId: tenant.id,
    leadId: lead.id,
    jobIds: rows.map((r) => r.id),
    rows,
  };
});

afterAll(async () => {
  if (!sortFx) return;
  try {
    await db.delete(jobsTable).where(inArray(jobsTable.id, sortFx.jobIds));
    await db.delete(leadsTable).where(eq(leadsTable.id, sortFx.leadId));
    await db.delete(tenantsTable).where(eq(tenantsTable.id, sortFx.tenantId));
  } catch {
    /* best-effort cleanup */
  }
});

describe("GET /drilldown/revenue-attributed — stable paging for tied customer/date sorts (real Postgres)", () => {
  const sortRange = () =>
    `tenantId=${sortFx.tenantId}&startDate=${START_DATE}&endDate=${END_DATE}`;

  // The total order the route's ORDER BY produces: primary key first, then
  // jobs.id as the unique tiebreaker — both in the requested direction (desc
  // reverses the whole comparator, tiebreaker included).
  const expectedOrder = (key: "customer" | "date", dir: "asc" | "desc"): number[] =>
    [...sortFx.rows]
      .sort((a, b) => {
        let cmp =
          key === "customer"
            ? a.customerName < b.customerName
              ? -1
              : a.customerName > b.customerName
                ? 1
                : 0
            : a.invoiceDateMs - b.invoiceDateMs;
        if (cmp === 0) cmp = a.id - b.id; // unique id tiebreak
        return dir === "asc" ? cmp : -cmp;
      })
      .map((r) => r.id);

  async function walkPages(query: string, expected: number[]): Promise<void> {
    const total = expected.length;

    // The route's own full (limit=all) ordering is the source of truth the
    // pages must match. Assert it equals the intended total order so a broken
    // tiebreaker is caught even if every page happened to agree with itself.
    const full = await getJson(app, `${query}&limit=all`);
    expect(full.status).toBe(200);
    const fullIds = (full.json as ListRow[]).map((r) => r.id);
    expect(fullIds).toEqual(expected);

    const limit = 2;
    const pages: number[][] = [];
    for (let offset = 0; offset < total; offset += limit) {
      const res = await getJson(app, `${query}&limit=${limit}&offset=${offset}`);
      expect(res.status).toBe(200);
      // Count is the full filtered total on every page, never the page size.
      expect(res.headers["x-total-count"]).toBe(String(total));
      pages.push((res.json as ListRow[]).map((r) => r.id));
    }

    // Every page is exactly the matching slice of the full ordering.
    pages.forEach((ids, i) => {
      expect(ids).toEqual(fullIds.slice(i * limit, i * limit + limit));
    });

    // Pages reassemble the full list in order (no skipped rows) and share no
    // ids (no overlap) — the two failure modes of paging a non-unique sort.
    const reassembled = pages.flat();
    expect(reassembled).toEqual(fullIds);
    expect(new Set(reassembled).size).toBe(reassembled.length);
  }

  for (const dir of ["asc", "desc"] as const) {
    it(`sort=customer&dir=${dir}: tied names page into disjoint, ordered slices`, async () => {
      await walkPages(
        `/drilldown/revenue-attributed?${sortRange()}&sort=customer&dir=${dir}`,
        expectedOrder("customer", dir),
      );
    });

    it(`sort=date&dir=${dir}: tied invoice dates page into disjoint, ordered slices`, async () => {
      await walkPages(
        `/drilldown/revenue-attributed?${sortRange()}&sort=date&dir=${dir}`,
        expectedOrder("date", dir),
      );
    });
  }
});
