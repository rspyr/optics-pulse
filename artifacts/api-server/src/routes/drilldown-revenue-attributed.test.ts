// Coverage for the money-facing + access-control contract of the
// Revenue Attributed drilldown (task: attributed-revenue endpoint tests):
//
//   GET   /drilldown/revenue-attributed
//   PATCH /drilldown/jobs/:id/lead
//
// What we assert:
//   1. Corrected (rebate-inclusive) revenue math reconciles with the
//      same formula /drilldown/jobs orders by, for the same job range.
//   2. The itemized rebate breakdown + salesperson name flow through
//      from sold_estimates, with the "largest rebate wins" de-dupe and
//      the lead.assignedTo fallback for soldByName.
//   3. Clients cannot call the manual-match endpoint (agency-only) and
//      cannot see another tenant's jobs (list scope is forced to the
//      session tenant, never the attacker-supplied query.tenantId).
//
// Like the sibling tenant-scope tests, this exercises the real express
// router end-to-end with drizzle + the db mocked out, so no real
// database is required. The corrected-revenue formula under test is:
//   COALESCE(invoiceTotal + COALESCE(invoiceRebateAmount, 0), revenue)

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NO_TENANT_ASSIGNED_ERROR } from "../lib/tenant-scope";

const mockDb = {
  selectResults: [] as unknown[][],
  updateResults: [] as unknown[][],
  _selectIdx: 0,
  _updateIdx: 0,
  // Records the limit/offset args the first select's jobs query was called with,
  // so paging tests can assert the page boundary forwarded to the DB.
  lastLimit: undefined as number | undefined,
  lastOffset: undefined as number | undefined,
  reset() {
    this._selectIdx = 0;
    this._updateIdx = 0;
    this.selectResults = [];
    this.updateResults = [];
    this.lastLimit = undefined;
    this.lastOffset = undefined;
  },
};

interface ThenableIterable extends Record<string, unknown> {
  then: (resolve: Function, reject?: Function) => Promise<unknown>;
  [Symbol.iterator]: () => Generator<unknown>;
}

function makeThenable(result: unknown[]): ThenableIterable {
  return {
    then: (resolve: Function, reject?: Function) =>
      Promise.resolve(result).then(resolve as (v: unknown) => unknown, reject as (e: unknown) => unknown),
    [Symbol.iterator]: function* () {
      yield* result;
    },
  };
}

// Permissive select chain: supports both the jobs query
// (.where(...).orderBy(...).limit(...)) and the terminal awaited
// .where(inArray(...)) used for the sold_estimates / leads lookups.
function makeSelectChain(results: () => unknown[]) {
  const chain: Record<string, unknown> = {};
  const thenResult = () => makeThenable(results());
  const passthrough = () => chain;
  chain.from = vi.fn().mockImplementation(passthrough);
  chain.innerJoin = vi.fn().mockImplementation(passthrough);
  chain.leftJoin = vi.fn().mockImplementation(passthrough);
  chain.then = (resolve: Function, reject?: Function) =>
    Promise.resolve(results()).then(resolve as (v: unknown) => unknown, reject as (e: unknown) => unknown);
  // .limit() may be terminal, or chained with .offset() (e.g. /drilldown/jobs
  // does `.orderBy(...).limit(n).offset(m)`), so the limit return must also
  // expose .offset resolving to the same results.
  const limitReturn = (n?: number) => {
    if (typeof n === "number") mockDb.lastLimit = n;
    return Object.assign(thenResult(), {
      offset: vi.fn().mockImplementation((m?: number) => {
        if (typeof m === "number") mockDb.lastOffset = m;
        return Promise.resolve(results());
      }),
    });
  };
  chain.where = vi.fn().mockImplementation(() =>
    Object.assign(thenResult(), {
      orderBy: vi.fn().mockReturnValue(
        Object.assign(thenResult(), {
          limit: vi.fn().mockImplementation(limitReturn),
        }),
      ),
      limit: vi.fn().mockImplementation(limitReturn),
    }),
  );
  chain.orderBy = vi.fn().mockReturnValue(
    Object.assign(thenResult(), { limit: vi.fn().mockImplementation(limitReturn) }),
  );
  chain.limit = vi.fn().mockImplementation(limitReturn);
  return chain;
}

function makeUpdateChain(results: () => unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.set = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockReturnValue(chain);
  chain.returning = vi.fn().mockImplementation(() => Promise.resolve(results()));
  return chain;
}

vi.mock("@workspace/db", () => {
  const tablecol = (t: string) => new Proxy({}, { get: (_, k) => `${t}.${String(k)}` });
  return {
    db: {
      select: vi.fn().mockImplementation(() => {
        const idx = mockDb._selectIdx++;
        return makeSelectChain(() => mockDb.selectResults[idx] || []);
      }),
      update: vi.fn().mockImplementation(() => {
        const idx = mockDb._updateIdx++;
        return makeUpdateChain(() => mockDb.updateResults[idx] || []);
      }),
    },
    leadsTable: tablecol("leads"),
    jobsTable: tablecol("jobs"),
    soldEstimatesTable: tablecol("sold_estimates"),
  };
});

function asAble(obj: Record<string, unknown>) {
  obj.as = vi.fn().mockReturnValue(obj);
  return obj;
}
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...a: unknown[]) => asAble({ __op: "eq", a })),
  and: vi.fn((...a: unknown[]) => asAble({ __op: "and", a })),
  or: vi.fn((...a: unknown[]) => asAble({ __op: "or", a })),
  desc: vi.fn((...a: unknown[]) => asAble({ __op: "desc", a })),
  sql: Object.assign(
    vi.fn((..._a: unknown[]) => asAble({ __op: "sql" })),
    { join: vi.fn((...a: unknown[]) => asAble({ __op: "sql.join", a })) },
  ),
  inArray: vi.fn((...a: unknown[]) => asAble({ __op: "inArray", a })),
  gte: vi.fn((...a: unknown[]) => asAble({ __op: "gte", a })),
  lte: vi.fn((...a: unknown[]) => asAble({ __op: "lte", a })),
  SQL: class {},
}));

import express, { type Request, type Response, type NextFunction } from "express";

async function setupApp(role: string, tenantId: number | null) {
  vi.resetModules();
  const mod = await import("./drilldown");
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { session: Record<string, unknown> }).session = {
      userId: 1,
      userRole: role,
      tenantId,
    };
    next();
  });
  app.use(mod.default);
  return app;
}

function request(
  app: express.Express,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> | unknown[] }> {
  return new Promise((resolve, reject) => {
    const http = require("http");
    const server = http.createServer(app);
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      const payload = body !== undefined ? JSON.stringify(body) : undefined;
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path,
          method,
          headers: payload
            ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload).toString() }
            : {},
        },
        (res: { statusCode: number; on: Function }) => {
          let data = "";
          res.on("data", (chunk: string) => (data += chunk));
          res.on("end", () => {
            server.close();
            resolve({ status: res.statusCode, json: data ? JSON.parse(data) : {} });
          });
        },
      );
      req.on("error", (err: unknown) => {
        server.close();
        reject(err);
      });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

async function tenantEqArgsFor(table: string): Promise<unknown[]> {
  const drizzle = await import("drizzle-orm");
  return vi
    .mocked(drizzle.eq)
    .mock.calls.filter((c) => (c[0] as unknown as string) === `${table}.tenantId`)
    .map((c) => c[1]);
}

// The corrected-revenue formula the route computes in JS, mirroring the
// jobRevenueExpr that /drilldown/jobs orders by. The route rounds to whole
// cents (Math.round(n * 100) / 100) so floating-point `real` columns don't
// leak sub-cent drift like 1050.1500000000001; this helper rounds the same
// way so reconciliation comparisons match what the endpoint returns.
const round2 = (n: number) => Math.round(n * 100) / 100;
function correctedRevenueOf(job: {
  invoiceTotal: number | null;
  invoiceRebateAmount: number | null;
  revenue: number;
}): number {
  return round2(
    job.invoiceTotal != null ? job.invoiceTotal + (job.invoiceRebateAmount ?? 0) : job.revenue,
  );
}

describe("GET /drilldown/revenue-attributed", () => {
  beforeEach(() => {
    mockDb.reset();
    vi.clearAllMocks();
  });

  describe("corrected-revenue math reconciles with /drilldown/jobs", () => {
    // A range of completed jobs: two with invoices (rebate added back),
    // one falling back to legacy `revenue` because invoiceTotal is null.
    const jobs = [
      { id: 1, tenantId: 7, leadId: null, stJobId: "j1", stInvoiceId: "i1", customerName: "A",
        jobType: "hvac", jobTypeName: "HVAC", status: "completed",
        revenue: 1000, invoiceTotal: 900, invoiceRebateAmount: 150,
        invoiceDate: null, completedAt: null, createdAt: null, matchLevel: null, matchedGclid: null },
      { id: 2, tenantId: 7, leadId: null, stJobId: "j2", stInvoiceId: "i2", customerName: "B",
        jobType: "plumb", jobTypeName: "Plumbing", status: "completed",
        revenue: 500, invoiceTotal: 500, invoiceRebateAmount: null,
        invoiceDate: null, completedAt: null, createdAt: null, matchLevel: null, matchedGclid: null },
      { id: 3, tenantId: 7, leadId: null, stJobId: "j3", stInvoiceId: null, customerName: "C",
        jobType: "elec", jobTypeName: "Electrical", status: "completed",
        revenue: 750, invoiceTotal: null, invoiceRebateAmount: null,
        invoiceDate: null, completedAt: null, createdAt: null, matchLevel: null, matchedGclid: null },
    ];

    it("computes correctedRevenue = invoiceTotal + invoiceRebateAmount, falling back to revenue", async () => {
      const app = await setupApp("super_admin", null);
      // selects: [0] jobs. No estimates/leads (no jobIds estimates seeded, leadIds empty).
      mockDb.selectResults = [jobs, [{ total: 3 }], []];

      const res = await request(app, "GET", "/drilldown/revenue-attributed?tenantId=7&startDate=2026-01-01&endDate=2026-12-31");

      expect(res.status).toBe(200);
      const rows = res.json as Array<{ id: number; correctedRevenue: number }>;
      const byId = new Map(rows.map((r) => [r.id, r.correctedRevenue]));
      expect(byId.get(1)).toBe(1050); // 900 + 150
      expect(byId.get(2)).toBe(500); //  500 + 0
      expect(byId.get(3)).toBe(750); //  fallback to revenue
    });

    it("totals reconcile with the same formula applied to /drilldown/jobs rows", async () => {
      // revenue-attributed run
      const app1 = await setupApp("super_admin", null);
      mockDb.selectResults = [jobs, [{ total: 3 }], []];
      const attributed = await request(app1, "GET", "/drilldown/revenue-attributed?tenantId=7");
      expect(attributed.status).toBe(200);
      const attributedTotal = (attributed.json as Array<{ correctedRevenue: number }>)
        .reduce((sum, r) => sum + r.correctedRevenue, 0);

      // /drilldown/jobs run over the same job range — it rounds each money
      // field to whole cents and orders by jobRevenueExpr; applying the
      // corrected formula here must yield the identical total the drilldown
      // surfaced.
      mockDb.reset();
      vi.clearAllMocks();
      const app2 = await setupApp("super_admin", null);
      mockDb.selectResults = [jobs];
      const jobsRes = await request(app2, "GET", "/drilldown/jobs?tenantId=7&useJobDate=true&sort=revenue");
      expect(jobsRes.status).toBe(200);
      const jobsTotal = (jobsRes.json as typeof jobs).reduce((sum, j) => sum + correctedRevenueOf(j), 0);

      expect(attributedTotal).toBe(jobsTotal);
      expect(attributedTotal).toBe(1050 + 500 + 750);
    });
  });

  // Revenue columns are floating-point `real`, so fractional cents can produce
  // values like 900.10 + 150.05 = 1050.1500000000001 in JS. The endpoint must
  // round corrected revenue to whole cents (decision: round to 2 decimals
  // before returning) so clients never see spurious sub-cent precision drift,
  // and the ordering/reconciliation must stay consistent under fractional values.
  describe("fractional cents are rounded to 2 decimals (no precision drift)", () => {
    const fractionalJobs = [
      // 900.10 + 150.05 = 1050.1500000000001 in raw float → must round to 1050.15
      { id: 1, tenantId: 7, leadId: null, stJobId: "j1", stInvoiceId: "i1", customerName: "A",
        jobType: "hvac", jobTypeName: "HVAC", status: "completed",
        revenue: 1000, invoiceTotal: 900.1, invoiceRebateAmount: 150.05,
        invoiceDate: null, completedAt: null, createdAt: null, matchLevel: null, matchedGclid: null },
      // 0.1 + 0.2 = 0.30000000000000004 in raw float → must round to 0.3
      { id: 2, tenantId: 7, leadId: null, stJobId: "j2", stInvoiceId: "i2", customerName: "B",
        jobType: "plumb", jobTypeName: "Plumbing", status: "completed",
        revenue: 500, invoiceTotal: 0.1, invoiceRebateAmount: 0.2,
        invoiceDate: null, completedAt: null, createdAt: null, matchLevel: null, matchedGclid: null },
      // fallback to legacy revenue, also fractional
      { id: 3, tenantId: 7, leadId: null, stJobId: "j3", stInvoiceId: null, customerName: "C",
        jobType: "elec", jobTypeName: "Electrical", status: "completed",
        revenue: 12.005, invoiceTotal: null, invoiceRebateAmount: null,
        invoiceDate: null, completedAt: null, createdAt: null, matchLevel: null, matchedGclid: null },
    ];

    it("rounds correctedRevenue to whole cents instead of leaking float drift", async () => {
      const app = await setupApp("super_admin", null);
      mockDb.selectResults = [fractionalJobs, [{ total: 3 }], []];

      const res = await request(app, "GET", "/drilldown/revenue-attributed?tenantId=7");

      expect(res.status).toBe(200);
      const rows = res.json as Array<{ id: number; correctedRevenue: number }>;
      const byId = new Map(rows.map((r) => [r.id, r.correctedRevenue]));
      // Raw float would be 1050.1500000000001 / 0.30000000000000004 / 12.005.
      expect(byId.get(1)).toBe(1050.15);
      expect(byId.get(2)).toBe(0.3);
      expect(byId.get(3)).toBe(12.01); // 12.005 rounds up to 12.01
      // No value should carry more than 2 decimal places.
      for (const v of byId.values()) {
        expect(Number.isInteger(Math.round(v * 100))).toBe(true);
        expect(v).toBe(Math.round(v * 100) / 100);
      }
    });

    it("totals reconcile with /drilldown/jobs under fractional values (both rounded)", async () => {
      const app1 = await setupApp("super_admin", null);
      mockDb.selectResults = [fractionalJobs, [{ total: 3 }], []];
      const attributed = await request(app1, "GET", "/drilldown/revenue-attributed?tenantId=7");
      expect(attributed.status).toBe(200);
      const attributedTotal = round2(
        (attributed.json as Array<{ correctedRevenue: number }>)
          .reduce((sum, r) => sum + r.correctedRevenue, 0),
      );

      mockDb.reset();
      vi.clearAllMocks();
      const app2 = await setupApp("super_admin", null);
      mockDb.selectResults = [fractionalJobs];
      const jobsRes = await request(app2, "GET", "/drilldown/jobs?tenantId=7&useJobDate=true&sort=revenue");
      expect(jobsRes.status).toBe(200);
      const jobsTotal = round2(
        (jobsRes.json as typeof fractionalJobs).reduce((sum, j) => sum + correctedRevenueOf(j), 0),
      );

      expect(attributedTotal).toBe(jobsTotal);
      expect(attributedTotal).toBe(1050.15 + 0.3 + 12.01);
    });

    it("orders rows by corrected revenue descending, consistent across both endpoints", async () => {
      // The DB applies the ordering (desc on jobRevenueExpr); both endpoints
      // use the identical SQL expression, so a stable descending order over
      // fractional values is the contract. We feed the rows pre-sorted by the
      // corrected formula and assert both endpoints preserve that order and
      // that the per-row corrected values rank identically.
      const sorted = [...fractionalJobs].sort(
        (a, b) => correctedRevenueOf(b) - correctedRevenueOf(a),
      );

      const app1 = await setupApp("super_admin", null);
      mockDb.selectResults = [sorted, [{ total: 3 }], []];
      const attributed = await request(app1, "GET", "/drilldown/revenue-attributed?tenantId=7");
      expect(attributed.status).toBe(200);
      const attributedOrder = (attributed.json as Array<{ id: number; correctedRevenue: number }>)
        .map((r) => r.id);

      mockDb.reset();
      vi.clearAllMocks();
      const app2 = await setupApp("super_admin", null);
      mockDb.selectResults = [sorted];
      const jobsRes = await request(app2, "GET", "/drilldown/jobs?tenantId=7&useJobDate=true&sort=revenue");
      expect(jobsRes.status).toBe(200);
      const jobsOrder = (jobsRes.json as typeof fractionalJobs).map((j) => j.id);

      expect(attributedOrder).toEqual(jobsOrder);
      expect(attributedOrder).toEqual([1, 3, 2]); // 1050.15 > 12.01 > 0.30
    });
  });

  // /drilldown/jobs returns the raw job rows (used by the Command Center
  // revenue drilldown modal). Its money columns (revenue, invoiceTotal,
  // invoiceRebateAmount) come straight from floating-point `real` DB columns,
  // so the endpoint must round each to whole cents before returning so the
  // front-end never displays or aggregates sub-cent drift like 900.1000000001.
  describe("GET /drilldown/jobs rounds money fields to 2 decimals", () => {
    const driftJobs = [
      { id: 1, tenantId: 7, leadId: null, stJobId: "j1", stInvoiceId: "i1", customerName: "A",
        jobType: "hvac", jobTypeName: "HVAC", status: "completed",
        revenue: 900.1000000001, invoiceTotal: 900.1000000001, invoiceRebateAmount: 150.0499999999,
        invoiceDate: null, completedAt: null, createdAt: null, matchLevel: null, matchedGclid: null },
      { id: 2, tenantId: 7, leadId: null, stJobId: "j2", stInvoiceId: "i2", customerName: "B",
        jobType: "plumb", jobTypeName: "Plumbing", status: "completed",
        revenue: 12.005, invoiceTotal: null, invoiceRebateAmount: null,
        invoiceDate: null, completedAt: null, createdAt: null, matchLevel: null, matchedGclid: null },
    ];

    it("rounds revenue, invoiceTotal, and invoiceRebateAmount to whole cents", async () => {
      const app = await setupApp("super_admin", null);
      mockDb.selectResults = [driftJobs];

      const res = await request(app, "GET", "/drilldown/jobs?tenantId=7&useJobDate=true&sort=revenue");

      expect(res.status).toBe(200);
      const rows = res.json as Array<{
        id: number; revenue: number; invoiceTotal: number | null; invoiceRebateAmount: number | null;
      }>;
      const byId = new Map(rows.map((r) => [r.id, r]));
      const r1 = byId.get(1)!;
      expect(r1.revenue).toBe(900.1);
      expect(r1.invoiceTotal).toBe(900.1);
      expect(r1.invoiceRebateAmount).toBe(150.05);
      const r2 = byId.get(2)!;
      expect(r2.revenue).toBe(12.01); // 12.005 rounds up
      // null money fields stay null (not coerced to 0)
      expect(r2.invoiceTotal).toBeNull();
      expect(r2.invoiceRebateAmount).toBeNull();
      // No returned money value carries more than 2 decimal places.
      for (const r of rows) {
        for (const v of [r.revenue, r.invoiceTotal, r.invoiceRebateAmount]) {
          if (v == null) continue;
          expect(v).toBe(Math.round(v * 100) / 100);
        }
      }
    });
  });

  describe("itemized rebate breakdown + soldByName from sold_estimates", () => {
    const baseJob = {
      id: 10, tenantId: 7, leadId: 99, stJobId: "j10", stInvoiceId: "i10", customerName: "Estimate Co",
      jobType: "hvac", jobTypeName: "HVAC", status: "completed",
      revenue: 2000, invoiceTotal: 1800, invoiceRebateAmount: 300,
      invoiceDate: null, completedAt: null, createdAt: null, matchLevel: null, matchedGclid: null,
    };

    it("passes through the itemized breakdown and salesperson name", async () => {
      const breakdown = [
        { label: "ETO", amount: 200 },
        { label: "ODEE", amount: 100 },
      ];
      const app = await setupApp("super_admin", null);
      mockDb.selectResults = [
        [baseJob],
        [{ total: 1 }],
        [{ jobId: 10, soldByName: "Dana Sells", rebateAmount: 300, rebateBreakdown: breakdown }],
        [{ id: 99, firstName: "Lead", lastName: "Person", source: "ppc", originalSource: "ppc",
          status: "sold", hubStatus: null, assignedTo: "Fallback Rep" }],
      ];

      const res = await request(app, "GET", "/drilldown/revenue-attributed?tenantId=7");

      expect(res.status).toBe(200);
      const row = (res.json as Array<Record<string, unknown>>)[0];
      expect(row.soldByName).toBe("Dana Sells");
      expect(row.rebateBreakdown).toEqual(breakdown);
      expect(row.correctedRevenue).toBe(2100); // 1800 + 300
    });

    it("prefers the estimate with the largest rebate when a job has duplicates", async () => {
      const small = [{ label: "ETO", amount: 50 }];
      const big = [{ label: "ETO", amount: 200 }, { label: "ODEE", amount: 100 }];
      const app = await setupApp("super_admin", null);
      mockDb.selectResults = [
        [baseJob],
        [{ total: 1 }],
        [
          { jobId: 10, soldByName: "Small Rebate Rep", rebateAmount: 50, rebateBreakdown: small },
          { jobId: 10, soldByName: "Big Rebate Rep", rebateAmount: 300, rebateBreakdown: big },
        ],
        [],
      ];

      const res = await request(app, "GET", "/drilldown/revenue-attributed?tenantId=7");

      expect(res.status).toBe(200);
      const row = (res.json as Array<Record<string, unknown>>)[0];
      expect(row.soldByName).toBe("Big Rebate Rep");
      expect(row.rebateBreakdown).toEqual(big);
    });

    it("falls back to lead.assignedTo for soldByName when there is no estimate", async () => {
      const app = await setupApp("super_admin", null);
      mockDb.selectResults = [
        [baseJob],
        [{ total: 1 }],
        [], // no sold estimate for this job
        [{ id: 99, firstName: "Lead", lastName: "Person", source: "ppc", originalSource: "ppc",
          status: "sold", hubStatus: null, assignedTo: "Fallback Rep" }],
      ];

      const res = await request(app, "GET", "/drilldown/revenue-attributed?tenantId=7");

      expect(res.status).toBe(200);
      const row = (res.json as Array<Record<string, unknown>>)[0];
      expect(row.soldByName).toBe("Fallback Rep");
      expect(row.rebateBreakdown).toEqual([]);
      expect((row.lead as { id: number }).id).toBe(99);
    });
  });

  // Long lists used to silently truncate at 200 rows in the UI (limit=all was
  // only used by the CSV export). The endpoint now accepts `offset` so the UI
  // can page through the full list; offset must be applied to the jobs query,
  // and the follow-up estimate/lead lookups must only cover the returned page.
  describe("offset paging through long attributed-revenue lists", () => {
    it("applies offset to the jobs query and scopes follow-up lookups to the returned page", async () => {
      // Page 2 (offset=200): two completed jobs, each linking a distinct lead,
      // with one matching sold estimate. The estimate/lead lookups must only
      // ask for the ids on THIS page, never the whole range.
      const pageJobs = [
        { id: 201, tenantId: 7, leadId: 301, stJobId: "j201", stInvoiceId: "i201", customerName: "Page2 A",
          jobType: "hvac", jobTypeName: "HVAC", status: "completed",
          revenue: 900, invoiceTotal: 800, invoiceRebateAmount: 100,
          invoiceDate: null, completedAt: null, createdAt: null, matchLevel: null, matchedGclid: null },
        { id: 202, tenantId: 7, leadId: 302, stJobId: "j202", stInvoiceId: "i202", customerName: "Page2 B",
          jobType: "plumb", jobTypeName: "Plumbing", status: "completed",
          revenue: 400, invoiceTotal: 400, invoiceRebateAmount: null,
          invoiceDate: null, completedAt: null, createdAt: null, matchLevel: null, matchedGclid: null },
      ];
      const estimates = [{ jobId: 201, soldByName: "Rep A", rebateAmount: 100, rebateBreakdown: [{ label: "ETO", amount: 100 }] }];
      const leads = [
        { id: 301, firstName: "Lead", lastName: "One", source: "ppc", originalSource: "ppc", status: "sold", hubStatus: null, assignedTo: null },
        { id: 302, firstName: "Lead", lastName: "Two", source: "seo", originalSource: "seo", status: "sold", hubStatus: null, assignedTo: null },
      ];

      const app = await setupApp("super_admin", null);
      mockDb.selectResults = [pageJobs, [{ total: 2 }], estimates, leads];

      const drizzle = await import("drizzle-orm");
      const res = await request(app, "GET", "/drilldown/revenue-attributed?tenantId=7&limit=200&offset=200");
      expect(res.status).toBe(200);

      // Offset was forwarded to the jobs query at the requested page boundary.
      expect(mockDb.lastLimit).toBe(200);
      expect(mockDb.lastOffset).toBe(200);

      // Only the two job ids on this page were returned.
      const rows = res.json as Array<{ id: number }>;
      expect(rows.map((r) => r.id)).toEqual([201, 202]);

      // The estimate + lead lookups used inArray with ONLY this page's ids,
      // never the full range — so paging doesn't fan out into the whole list.
      const inArrayCalls = vi.mocked(drizzle.inArray).mock.calls;
      const estimateLookup = inArrayCalls.find((c) => (c[0] as unknown as string) === "sold_estimates.jobId");
      const leadLookup = inArrayCalls.find((c) => (c[0] as unknown as string) === "leads.id");
      expect(estimateLookup?.[1]).toEqual([201, 202]);
      expect(leadLookup?.[1]).toEqual([301, 302]);
    });

    it("does not apply an offset when none is supplied (page 1)", async () => {
      const pageJobs = [
        { id: 1, tenantId: 7, leadId: null, stJobId: "j1", stInvoiceId: "i1", customerName: "A",
          jobType: "hvac", jobTypeName: "HVAC", status: "completed",
          revenue: 1000, invoiceTotal: 900, invoiceRebateAmount: 150,
          invoiceDate: null, completedAt: null, createdAt: null, matchLevel: null, matchedGclid: null },
      ];

      const app = await setupApp("super_admin", null);
      mockDb.selectResults = [pageJobs, [{ total: 1 }], []];

      const res = await request(app, "GET", "/drilldown/revenue-attributed?tenantId=7&limit=200");
      expect(res.status).toBe(200);
      expect(mockDb.lastLimit).toBe(200);
      // No `.offset()` call when offset is absent (avoids an unnecessary OFFSET 0).
      expect(mockDb.lastOffset).toBeUndefined();
    });
  });

  describe("tenant scoping (clients cannot see other tenants' jobs)", () => {
    it("returns 403 'No tenant assigned' for a tenant-scoped role with no session tenant, and never reads the DB", async () => {
      const app = await setupApp("tenant_user", null);
      const res = await request(app, "GET", "/drilldown/revenue-attributed?tenantId=9");
      expect(res.status).toBe(403);
      expect(res.json).toEqual(NO_TENANT_ASSIGNED_ERROR);
      const dbMod = await import("@workspace/db");
      expect(vi.mocked(dbMod.db.select)).not.toHaveBeenCalled();
    });

    it("forces the session tenantId, ignoring an attacker-supplied query.tenantId", async () => {
      const app = await setupApp("tenant_user", 7);
      mockDb.selectResults = [[], [{ total: 0 }], []];
      const res = await request(app, "GET", "/drilldown/revenue-attributed?tenantId=9");
      expect(res.status).toBeLessThan(500);
      const tenantArgs = await tenantEqArgsFor("jobs");
      expect(tenantArgs).toContain(7);
      expect(tenantArgs).not.toContain(9);
      expect(tenantArgs).not.toContain("9");
    });
  });
});

// GET /drilldown/revenue-attributed/summary powers the Revenue Attributed
// summary cards. It returns full-range aggregates (corrected revenue, rebate
// add-back, attributed-only revenue, and job count) computed server-side via
// SQL SUM/COUNT, so the cards always reflect the entire date range regardless
// of which page of rows the list is showing. The aggregate math mirrors the
// per-row formulas /drilldown/revenue-attributed returns:
//   corrected revenue = COALESCE(invoiceTotal + COALESCE(invoiceRebateAmount,0), revenue)
//   rebate add-back    = SUM(COALESCE(invoiceRebateAmount, 0))
//   attributed         = same corrected revenue, but only WHERE matchLevel IS NOT NULL
//
// The db is mocked, so the SQL SUM/COUNT itself runs as if Postgres produced
// it: each test feeds the aggregate row Postgres would return for the dataset,
// then asserts the route maps + rounds it correctly. The reconciliation test
// proves that aggregate equals the sum of every row the list endpoint returns
// (with limit=all) for the same range/tenant — i.e. the cards can never drift
// from the list + CSV export.
describe("GET /drilldown/revenue-attributed/summary", () => {
  beforeEach(() => {
    mockDb.reset();
    vi.clearAllMocks();
  });

  // A mixed range of completed jobs that the list endpoint and the summary
  // aggregate must agree on:
  //   id 1 — invoiced (900 + 150 rebate), attributed (gclid)
  //   id 2 — invoiced (500, no rebate), NOT attributed (matchLevel null)
  //   id 3 — legacy fallback to `revenue` (750), attributed (manual)
  const rangeJobs = [
    { id: 1, tenantId: 7, leadId: null, stJobId: "j1", stInvoiceId: "i1", customerName: "A",
      jobType: "hvac", jobTypeName: "HVAC", status: "completed",
      revenue: 1000, invoiceTotal: 900, invoiceRebateAmount: 150,
      invoiceDate: null, completedAt: null, createdAt: null, matchLevel: "gclid", matchedGclid: "g1" },
    { id: 2, tenantId: 7, leadId: null, stJobId: "j2", stInvoiceId: "i2", customerName: "B",
      jobType: "plumb", jobTypeName: "Plumbing", status: "completed",
      revenue: 500, invoiceTotal: 500, invoiceRebateAmount: null,
      invoiceDate: null, completedAt: null, createdAt: null, matchLevel: null, matchedGclid: null },
    { id: 3, tenantId: 7, leadId: null, stJobId: "j3", stInvoiceId: null, customerName: "C",
      jobType: "elec", jobTypeName: "Electrical", status: "completed",
      revenue: 750, invoiceTotal: null, invoiceRebateAmount: null,
      invoiceDate: null, completedAt: null, createdAt: null, matchLevel: "manual", matchedGclid: null },
  ];

  // Mirrors the SQL aggregate the route runs (the raw, pre-rounding sums
  // Postgres would hand back). corrected = jobRevenueExpr; attributed only
  // counts rows with a non-null matchLevel; rebates add back invoiceRebateAmount.
  function aggregateOf(jobs: typeof rangeJobs) {
    const corrected = (j: (typeof rangeJobs)[number]) =>
      j.invoiceTotal != null ? j.invoiceTotal + (j.invoiceRebateAmount ?? 0) : j.revenue;
    let revenue = 0;
    let rebates = 0;
    let attributed = 0;
    for (const j of jobs) {
      revenue += corrected(j);
      rebates += j.invoiceRebateAmount ?? 0;
      if (j.matchLevel != null) attributed += corrected(j);
    }
    return { revenue, rebates, attributed, count: jobs.length };
  }

  it("returns full-range corrected revenue, rebate add-back, attributed revenue, and job count", async () => {
    const app = await setupApp("super_admin", null);
    // The summary route issues a single aggregate SELECT; feed the row Postgres
    // would return for rangeJobs (raw sums; the route rounds to whole cents).
    mockDb.selectResults = [[aggregateOf(rangeJobs)]];

    const res = await request(
      app,
      "GET",
      "/drilldown/revenue-attributed/summary?tenantId=7&startDate=2026-01-01&endDate=2026-12-31",
    );

    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      revenue: 2300, // (900+150) + 500 + 750
      rebates: 150, //  150 + 0 + 0
      attributed: 1800, // (900+150 gclid) + 750 (manual); id 2 excluded
      count: 3,
    });
  });

  it("totals equal the sum of every row the list endpoint returns with limit=all (same range/tenant)", async () => {
    // 1) Summary run — fed the aggregate Postgres computes for the range.
    const summaryApp = await setupApp("super_admin", null);
    mockDb.selectResults = [[aggregateOf(rangeJobs)]];
    const summaryRes = await request(
      summaryApp,
      "GET",
      "/drilldown/revenue-attributed/summary?tenantId=7&startDate=2026-01-01&endDate=2026-12-31",
    );
    expect(summaryRes.status).toBe(200);
    const summary = summaryRes.json as {
      revenue: number; rebates: number; attributed: number; count: number;
    };

    // 2) List run over the SAME range with limit=all — the route computes
    // correctedRevenue per row, so summing the rows must reproduce the cards.
    mockDb.reset();
    vi.clearAllMocks();
    const listApp = await setupApp("super_admin", null);
    // selects: [0] jobs, [1] count, [2] estimates (jobIds non-empty), leads skipped (leadId null).
    mockDb.selectResults = [rangeJobs, [{ total: rangeJobs.length }], []];
    const listRes = await request(
      listApp,
      "GET",
      "/drilldown/revenue-attributed?tenantId=7&startDate=2026-01-01&endDate=2026-12-31&limit=all",
    );
    expect(listRes.status).toBe(200);
    const rows = listRes.json as Array<{
      correctedRevenue: number; invoiceRebateAmount: number | null; matchLevel: string | null;
    }>;

    const listRevenue = round2(rows.reduce((sum, r) => sum + r.correctedRevenue, 0));
    const listRebates = round2(rows.reduce((sum, r) => sum + (r.invoiceRebateAmount ?? 0), 0));
    const listAttributed = round2(
      rows.reduce((sum, r) => sum + (r.matchLevel != null ? r.correctedRevenue : 0), 0),
    );

    // The cards reconcile with the full list, row for row.
    expect(rows).toHaveLength(summary.count);
    expect(listRevenue).toBe(summary.revenue);
    expect(listRebates).toBe(summary.rebates);
    expect(listAttributed).toBe(summary.attributed);
  });

  // Revenue columns are floating-point `real`, so SUM() can hand back values
  // like 1050.1500000000001. The summary must round each aggregate to whole
  // cents (matching the per-row round2 the list applies) so the cards never
  // show sub-cent drift.
  it("rounds fractional aggregate sums to whole cents", async () => {
    const app = await setupApp("super_admin", null);
    mockDb.selectResults = [[
      {
        revenue: 900.1 + 150.05, // 1050.1500000000001 in raw float
        rebates: 0.1 + 0.2, //      0.30000000000000004 in raw float
        attributed: 12.005, //      rounds up to 12.01
        count: 4,
      },
    ]];

    const res = await request(app, "GET", "/drilldown/revenue-attributed/summary?tenantId=7");

    expect(res.status).toBe(200);
    expect(res.json).toEqual({ revenue: 1050.15, rebates: 0.3, attributed: 12.01, count: 4 });
  });

  it("only aggregates completed jobs (status filter is always applied)", async () => {
    const app = await setupApp("super_admin", null);
    mockDb.selectResults = [[aggregateOf(rangeJobs)]];

    const res = await request(app, "GET", "/drilldown/revenue-attributed/summary?tenantId=7");

    expect(res.status).toBe(200);
    const drizzle = await import("drizzle-orm");
    const statusArgs = vi
      .mocked(drizzle.eq)
      .mock.calls.filter((c) => (c[0] as unknown as string) === "jobs.status")
      .map((c) => c[1]);
    expect(statusArgs).toContain("completed");
  });

  describe("tenant scoping (clients cannot see other tenants' totals)", () => {
    it("returns 403 'No tenant assigned' for a tenant-scoped role with no session tenant, and never reads the DB", async () => {
      const app = await setupApp("tenant_user", null);
      const res = await request(app, "GET", "/drilldown/revenue-attributed/summary?tenantId=9");
      expect(res.status).toBe(403);
      expect(res.json).toEqual(NO_TENANT_ASSIGNED_ERROR);
      const dbMod = await import("@workspace/db");
      expect(vi.mocked(dbMod.db.select)).not.toHaveBeenCalled();
    });

    it("forces the session tenantId, ignoring an attacker-supplied query.tenantId", async () => {
      const app = await setupApp("tenant_user", 7);
      mockDb.selectResults = [[aggregateOf(rangeJobs)]];
      const res = await request(app, "GET", "/drilldown/revenue-attributed/summary?tenantId=9");
      expect(res.status).toBeLessThan(500);
      const tenantArgs = await tenantEqArgsFor("jobs");
      expect(tenantArgs).toContain(7);
      expect(tenantArgs).not.toContain(9);
      expect(tenantArgs).not.toContain("9");
    });
  });
});

describe("PATCH /drilldown/jobs/:id/lead (manual match — agency only)", () => {
  beforeEach(() => {
    mockDb.reset();
    vi.clearAllMocks();
  });

  for (const role of ["client_user", "client_admin", "tenant_user"]) {
    it(`rejects ${role} with 403 and never reads or writes the DB`, async () => {
      const app = await setupApp(role, 7);
      const res = await request(app, "PATCH", "/drilldown/jobs/5/lead", { leadId: 42 });
      expect(res.status).toBe(403);
      expect(res.json).toEqual({ error: "Only agency users can manually match jobs to leads." });
      const dbMod = await import("@workspace/db");
      expect(vi.mocked(dbMod.db.select)).not.toHaveBeenCalled();
      expect(vi.mocked(dbMod.db.update)).not.toHaveBeenCalled();
    });
  }

  it("allows agency_user to manually match a job to a lead", async () => {
    const app = await setupApp("agency_user", 1);
    mockDb.selectResults = [
      [{ id: 5, tenantId: 7 }], // job lookup
      [{ id: 42, tenantId: 7 }], // lead lookup
    ];
    mockDb.updateResults = [[{ id: 5, leadId: 42, matchLevel: "manual" }]];

    const res = await request(app, "PATCH", "/drilldown/jobs/5/lead", { leadId: 42 });

    expect(res.status).toBe(200);
    expect(res.json).toEqual({ id: 5, leadId: 42, matchLevel: "manual" });
    const dbMod = await import("@workspace/db");
    expect(vi.mocked(dbMod.db.update)).toHaveBeenCalled();
  });

  it("allows super_admin to clear a job's lead (leadId null)", async () => {
    const app = await setupApp("super_admin", null);
    mockDb.selectResults = [[{ id: 5, tenantId: 7 }]];
    mockDb.updateResults = [[{ id: 5, leadId: null, matchLevel: null }]];

    const res = await request(app, "PATCH", "/drilldown/jobs/5/lead", { leadId: null });

    expect(res.status).toBe(200);
    expect(res.json).toEqual({ id: 5, leadId: null, matchLevel: null });
  });

  it("rejects a lead that belongs to a different tenant than the job (404)", async () => {
    const app = await setupApp("agency_user", 1);
    mockDb.selectResults = [
      [{ id: 5, tenantId: 7 }], // job in tenant 7
      [{ id: 42, tenantId: 9 }], // lead in tenant 9 — mismatch
    ];

    const res = await request(app, "PATCH", "/drilldown/jobs/5/lead", { leadId: 42 });

    expect(res.status).toBe(404);
    expect(res.json).toEqual({ error: "Lead not found" });
    const dbMod = await import("@workspace/db");
    expect(vi.mocked(dbMod.db.update)).not.toHaveBeenCalled();
  });
});
