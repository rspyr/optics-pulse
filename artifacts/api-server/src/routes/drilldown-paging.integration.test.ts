/**
 * Real-Postgres integration coverage for **stable LIMIT/OFFSET paging** on the
 * sibling drilldown lists:
 *
 *   GET /drilldown/jobs   (sort=revenue and the default date sort)
 *   GET /drilldown/leads  (date sort)
 *
 * The sibling unit test (`drilldown-revenue-attributed.test.ts`) mocks the db,
 * so it can only prove these routes wire up the right params/expressions — it
 * returns whatever rows it is handed regardless of the ORDER BY. It cannot
 * prove the SQL the ORDER BY compiles to pages correctly against Postgres.
 *
 * The dangerous case is ties: two jobs with the same corrected revenue (or the
 * same createdAt), or two leads with the same createdAt. Postgres gives no
 * guaranteed order among rows the ORDER BY can't distinguish, so paging a
 * non-unique sort with LIMIT/OFFSET can serve a tied row twice (overlap) or
 * drop one (skip). Both handlers now append the unique primary key (id) as a
 * tiebreaker in the same direction as the primary sort, giving a total order.
 *
 * This file seeds a fresh tenant with deliberately *tied* revenues/timestamps
 * arranged so a tied group straddles a page boundary, then walks the pages and
 * asserts they are disjoint, correctly-ordered slices of each route's own full
 * ordering — and that that full ordering matches the intended total order
 * (primary key, then id desc). Remove the id tiebreaker and these fail.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import express, { type Request, type Response, type NextFunction } from "express";
import http from "http";

const dbModule = await import("@workspace/db");
const { db, tenantsTable, leadsTable, jobsTable } = dbModule;
const routerMod = await import("./drilldown");

const START_DATE = "2026-01-01";
const END_DATE = "2026-12-31";
const SOURCE_GOOGLE = "Google";

function makeApp(): express.Express {
  const a = express();
  a.use(express.json());
  // super_admin with no session tenant → scope comes from query.tenantId.
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

type Row = { id: number };

let app: express.Express;

// ---------------------------------------------------------------------------
// /drilldown/jobs — tied revenues (sort=revenue) and tied createdAt (date sort)
// ---------------------------------------------------------------------------
interface JobRow {
  id: number;
  revenue: number; // corrected revenue == invoiceTotal here (rebate 0)
  createdAtMs: number;
}
interface JobFx {
  tenantId: number;
  leadId: number;
  jobIds: number[];
  rows: JobRow[]; // insertion order → id ascending
}
let jobFx: JobFx;

// Two tied corrected revenues and two tied createdAt timestamps, all in range.
// Each combo repeats so both the revenue sort and the date sort have ties that
// span page boundaries under limit=2.
const REV_LOW = 1000;
const REV_HIGH = 2000;
const CREATED_EARLY = new Date("2026-03-10T12:00:00.000Z");
const CREATED_LATE = new Date("2026-03-20T12:00:00.000Z");
const IN_RANGE_INVOICE = new Date("2026-03-15T12:00:00.000Z");

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  const slug = `drill-jobs-page`;
  const [tenant] = await db
    .insert(tenantsTable)
    .values({ name: `Drilldown Jobs Paging ${slug}`, clientSlug: slug })
    .returning();

  const [lead] = await db
    .insert(leadsTable)
    .values({
      tenantId: tenant.id,
      firstName: "Jobs",
      lastName: slug,
      source: SOURCE_GOOGLE,
      originalSource: SOURCE_GOOGLE,
      leadType: "PagingFunnel",
    })
    .returning();

  const mkJob = async (revenue: number, createdAt: Date) => {
    const [job] = await db
      .insert(jobsTable)
      .values({
        tenantId: tenant.id,
        leadId: lead.id,
        jobType: "hvac",
        jobTypeName: "HVAC",
        status: "completed",
        // invoiceRebateAmount 0 → corrected revenue == invoiceTotal == revenue.
        revenue,
        invoiceTotal: revenue,
        invoiceRebateAmount: 0,
        matchLevel: "gclid",
        invoiceDate: IN_RANGE_INVOICE,
        createdAt,
      })
      .returning();
    return job;
  };

  // Insertion order fixes id ascending (serial). Arrangement gives:
  //   - revenue ties: REV_HIGH ×3, REV_LOW ×3
  //   - createdAt ties: EARLY on rows 1,3,5; LATE on rows 2,4,6
  // With limit=2 a tied group straddles a page boundary under both sorts.
  const specs: { revenue: number; createdAt: Date }[] = [
    { revenue: REV_HIGH, createdAt: CREATED_EARLY },
    { revenue: REV_HIGH, createdAt: CREATED_LATE },
    { revenue: REV_HIGH, createdAt: CREATED_EARLY },
    { revenue: REV_LOW, createdAt: CREATED_LATE },
    { revenue: REV_LOW, createdAt: CREATED_EARLY },
    { revenue: REV_LOW, createdAt: CREATED_LATE },
  ];

  const rows: JobRow[] = [];
  for (const spec of specs) {
    const job = await mkJob(spec.revenue, spec.createdAt);
    rows.push({ id: job.id, revenue: spec.revenue, createdAtMs: spec.createdAt.getTime() });
  }

  jobFx = { tenantId: tenant.id, leadId: lead.id, jobIds: rows.map((r) => r.id), rows };
  app = makeApp();
});

afterAll(async () => {
  if (!jobFx) return;
  try {
    await db.delete(jobsTable).where(inArray(jobsTable.id, jobFx.jobIds));
    await db.delete(leadsTable).where(eq(leadsTable.id, jobFx.leadId));
    await db.delete(tenantsTable).where(eq(tenantsTable.id, jobFx.tenantId));
  } catch {
    /* best-effort cleanup */
  }
  vi.restoreAllMocks();
});

describe("GET /drilldown/jobs — stable paging for tied revenue/date sorts (real Postgres)", () => {
  const jobsRange = () =>
    `tenantId=${jobFx.tenantId}&startDate=${START_DATE}&endDate=${END_DATE}&useJobDate=true`;

  // The total order the route's ORDER BY produces: primary key first (always
  // desc), then jobs.id desc as the unique tiebreaker.
  const expectedOrder = (key: "revenue" | "date"): number[] =>
    [...jobFx.rows]
      .sort((a, b) => {
        let cmp = key === "revenue" ? a.revenue - b.revenue : a.createdAtMs - b.createdAtMs;
        if (cmp === 0) cmp = a.id - b.id;
        return -cmp; // both primary sort and tiebreaker are desc
      })
      .map((r) => r.id);

  async function walkPages(query: string, expected: number[]): Promise<void> {
    const total = expected.length;

    // Source of truth: the route's own full (unpaged) ordering. Assert it
    // equals the intended total order so a broken tiebreaker is caught even if
    // every page happened to agree with itself.
    const full = await getJson(app, `${query}&limit=1000&offset=0`);
    expect(full.status).toBe(200);
    const fullIds = (full.json as Row[]).map((r) => r.id);
    expect(fullIds).toEqual(expected);

    const limit = 2;
    const pages: number[][] = [];
    for (let offset = 0; offset < total; offset += limit) {
      const res = await getJson(app, `${query}&limit=${limit}&offset=${offset}`);
      expect(res.status).toBe(200);
      pages.push((res.json as Row[]).map((r) => r.id));
    }

    // Every page is exactly the matching slice of the full ordering.
    pages.forEach((ids, i) => {
      expect(ids).toEqual(fullIds.slice(i * limit, i * limit + limit));
    });

    // Pages reassemble the full list in order (no skips) and share no ids (no
    // overlap) — the two failure modes of paging a non-unique sort.
    const reassembled = pages.flat();
    expect(reassembled).toEqual(fullIds);
    expect(new Set(reassembled).size).toBe(reassembled.length);
  }

  it("sort=revenue: tied corrected revenues page into disjoint, ordered slices", async () => {
    await walkPages(`/drilldown/jobs?${jobsRange()}&sort=revenue`, expectedOrder("revenue"));
  });

  it("default date sort: tied createdAt timestamps page into disjoint, ordered slices", async () => {
    // No sort param → defaults to date (desc on jobs.createdAt).
    await walkPages(`/drilldown/jobs?${jobsRange()}`, expectedOrder("date"));
  });
});

// ---------------------------------------------------------------------------
// /drilldown/leads — tied createdAt (date sort)
// ---------------------------------------------------------------------------
interface LeadRow {
  id: number;
  createdAtMs: number;
}
interface LeadFx {
  tenantId: number;
  leadIds: number[];
  rows: LeadRow[]; // insertion order → id ascending
}
let leadFx: LeadFx;

beforeAll(async () => {
  const slug = `drill-leads-page`;
  const [tenant] = await db
    .insert(tenantsTable)
    .values({ name: `Drilldown Leads Paging ${slug}`, clientSlug: slug })
    .returning();

  const mkLead = async (createdAt: Date) => {
    const [lead] = await db
      .insert(leadsTable)
      .values({
        tenantId: tenant.id,
        firstName: "LeadPage",
        lastName: slug,
        source: SOURCE_GOOGLE,
        originalSource: SOURCE_GOOGLE,
        leadType: "PagingFunnel",
        createdAt,
      })
      .returning();
    return lead;
  };

  // Six leads with createdAt ties (EARLY ×3, LATE ×3) interleaved so a tied
  // group straddles a page boundary under limit=2.
  const dates = [
    CREATED_EARLY,
    CREATED_LATE,
    CREATED_EARLY,
    CREATED_LATE,
    CREATED_EARLY,
    CREATED_LATE,
  ];
  const rows: LeadRow[] = [];
  for (const d of dates) {
    const lead = await mkLead(d);
    rows.push({ id: lead.id, createdAtMs: d.getTime() });
  }

  leadFx = { tenantId: tenant.id, leadIds: rows.map((r) => r.id), rows };
});

afterAll(async () => {
  if (!leadFx) return;
  try {
    await db.delete(leadsTable).where(inArray(leadsTable.id, leadFx.leadIds));
    await db.delete(tenantsTable).where(eq(tenantsTable.id, leadFx.tenantId));
  } catch {
    /* best-effort cleanup */
  }
});

describe("GET /drilldown/leads — stable paging for tied createdAt (real Postgres)", () => {
  const leadsRange = () =>
    `tenantId=${leadFx.tenantId}&startDate=${START_DATE}&endDate=${END_DATE}`;

  // createdAt desc, then leads.id desc as the unique tiebreaker.
  const expectedOrder = (): number[] =>
    [...leadFx.rows]
      .sort((a, b) => {
        let cmp = a.createdAtMs - b.createdAtMs;
        if (cmp === 0) cmp = a.id - b.id;
        return -cmp;
      })
      .map((r) => r.id);

  it("tied createdAt timestamps page into disjoint, ordered slices that reassemble the full list", async () => {
    const expected = expectedOrder();
    const total = expected.length;

    const full = await getJson(app, `/drilldown/leads?${leadsRange()}&limit=1000&offset=0`);
    expect(full.status).toBe(200);
    const fullIds = (full.json as Row[]).map((r) => r.id);
    expect(fullIds).toEqual(expected);

    const limit = 2;
    const pages: number[][] = [];
    for (let offset = 0; offset < total; offset += limit) {
      const res = await getJson(app, `/drilldown/leads?${leadsRange()}&limit=${limit}&offset=${offset}`);
      expect(res.status).toBe(200);
      pages.push((res.json as Row[]).map((r) => r.id));
    }

    pages.forEach((ids, i) => {
      expect(ids).toEqual(fullIds.slice(i * limit, i * limit + limit));
    });

    const reassembled = pages.flat();
    expect(reassembled).toEqual(fullIds);
    expect(new Set(reassembled).size).toBe(reassembled.length);
  });
});
