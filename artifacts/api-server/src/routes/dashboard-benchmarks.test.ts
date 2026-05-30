import { describe, it, expect, vi, beforeEach } from "vitest";

// Minimal db.select() chain that supports the shapes used by the benchmarks
// endpoint:
//   from().where()                       -> thenable (active-tenant subqueries,
//                                            leadStats, jobStats)
//   from().innerJoin().where()           -> thenable (spendResult, closeRateStats)
// Each select() call pulls the next queued result off `mockDb.selectResults` by
// index, so seeding mirrors the route's select order exactly.
const mockDb = {
  selectResults: [] as unknown[][],
  _selectIdx: 0,
  reset() {
    this._selectIdx = 0;
    this.selectResults = [];
  },
};

function thenable(result: unknown[]) {
  return {
    then: (resolve: Function, reject?: Function) =>
      Promise.resolve(result).then(
        resolve as (v: unknown) => unknown,
        reject as (e: unknown) => unknown,
      ),
  };
}

function makeSelectChain(results: () => unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn().mockReturnValue(chain);
  chain.innerJoin = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockReturnValue(
    Object.assign(thenable(results()), {
      groupBy: vi.fn().mockImplementation(() => Promise.resolve(results())),
    }),
  );
  chain.then = (resolve: Function, reject?: Function) =>
    Promise.resolve(results()).then(
      resolve as (v: unknown) => unknown,
      reject as (e: unknown) => unknown,
    );
  return chain;
}

const tableProxy = (name: string) =>
  new Proxy(
    {},
    { get: (_t, prop) => `${name}.${String(prop)}` },
  );

vi.mock("@workspace/db", () => ({
  db: {
    select: vi.fn().mockImplementation(() => {
      const idx = mockDb._selectIdx++;
      return makeSelectChain(() => mockDb.selectResults[idx] || []);
    }),
  },
  leadsTable: tableProxy("leads"),
  jobsTable: tableProxy("jobs"),
  campaignsTable: tableProxy("campaigns"),
  campaignDailyStatsTable: tableProxy("campaign_daily_stats"),
  attributionEventsTable: tableProxy("attribution_events"),
  tenantsTable: tableProxy("tenants"),
}));

// Shared, stable drizzle-orm spies. They must survive the vi.resetModules() in
// setupApp so that, after dashboard.ts is re-imported, the route still calls the
// *same* eq mock the tests inspect. vi.hoisted gives us that stable reference;
// an inline factory would mint fresh fns on every re-import, breaking the
// `eq(tenantsTable.isActive, true)` assertion below.
const drizzle = vi.hoisted(() => ({
  eq: vi.fn((...a: unknown[]) => a),
  and: vi.fn((...a: unknown[]) => a),
  gte: vi.fn((...a: unknown[]) => a),
  lte: vi.fn((...a: unknown[]) => a),
  count: vi.fn((...a: unknown[]) => a),
  sum: vi.fn((...a: unknown[]) => a),
  sql: vi.fn((...a: unknown[]) => a),
  inArray: vi.fn((...a: unknown[]) => a),
  desc: vi.fn((...a: unknown[]) => a),
  SQL: class {},
}));

vi.mock("drizzle-orm", () => drizzle);

vi.mock("../middleware/auth", () => ({
  requireRole:
    (...roles: string[]) =>
    (req: { session?: { userRole?: string } }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
      if (roles.includes(req.session?.userRole ?? "")) return next();
      res.status(403).json({ error: "Forbidden" });
    },
  denyClientUser: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../lib/tenant-scope", () => ({
  resolveListTenantScope: vi.fn(),
  TENANT_REQUIRED_ERROR: "TENANT_REQUIRED",
  NO_TENANT_ASSIGNED_ERROR: "NO_TENANT_ASSIGNED",
}));

import express, { type Request, type Response, type NextFunction } from "express";

async function setupApp(role: string) {
  vi.resetModules();
  const mod = await import("./dashboard");
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { session: Record<string, unknown> }).session = {
      userId: 1,
      userRole: role,
      tenantId: null,
    };
    next();
  });
  app.use(mod.default);
  return app;
}

function getJson(
  app: express.Express,
  path: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve) => {
    const http = require("http");
    const server = http.createServer(app);
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      const req = http.request(
        { hostname: "127.0.0.1", port, path, method: "GET" },
        (res: { statusCode: number; on: Function }) => {
          let data = "";
          res.on("data", (chunk: string) => (data += chunk));
          res.on("end", () => {
            server.close();
            resolve({ status: res.statusCode, json: data ? JSON.parse(data) : {} });
          });
        },
      );
      req.end();
    });
  });
}

// Select order inside the endpoint. The four active-tenant subqueries are built
// first (one each for the lead, job, spend and close-rate WHERE clauses), then
// the four aggregate selects run inside Promise.all:
//   [0] lead-conditions active-tenant subquery
//   [1] job-conditions active-tenant subquery
//   [2] spend-conditions active-tenant subquery
//   [3] close-rate-conditions active-tenant subquery
//   [4] leadStats   -> { totalLeads, bookedLeads, soldLeads }
//   [5] jobStats    -> { revenue, invoicedJobCount }
//   [6] spendResult -> { total }
//   [7] closeRateStats -> { bookedWithInvoice }
// The subquery selects (0-3) are passed to inArray and never awaited, so their
// values are irrelevant; only indexes 4-7 shape the response.
function seed(opts: {
  totalLeads: number;
  bookedLeads: number;
  soldLeads: number;
  revenue: number;
  invoicedJobCount: number;
  spend: number;
  bookedWithInvoice: number;
}) {
  mockDb.selectResults = [
    [{ id: 1 }], // [0] lead-conditions active-tenant subquery
    [{ id: 1 }], // [1] job-conditions active-tenant subquery
    [{ id: 1 }], // [2] spend-conditions active-tenant subquery
    [{ id: 1 }], // [3] close-rate-conditions active-tenant subquery
    [
      {
        totalLeads: opts.totalLeads,
        bookedLeads: opts.bookedLeads,
        soldLeads: opts.soldLeads,
      },
    ],
    [{ revenue: opts.revenue, invoicedJobCount: opts.invoicedJobCount }],
    [{ total: opts.spend }],
    [{ bookedWithInvoice: opts.bookedWithInvoice }],
  ];
}

describe("GET /dashboard/benchmarks", () => {
  beforeEach(() => {
    mockDb.reset();
  });

  it("computes cpl, bookingRate, closeRate, avgSaleValue and roas from the aggregates", async () => {
    // 100 leads, 40 booked, 20 sold; 50000 completed revenue across 25 invoiced
    // jobs; 10000 spend; 20 booked leads carrying an invoice.
    seed({
      totalLeads: 100,
      bookedLeads: 40,
      soldLeads: 20,
      revenue: 50000,
      invoicedJobCount: 25,
      spend: 10000,
      bookedWithInvoice: 20,
    });

    const app = await setupApp("super_admin");
    const { status, json } = await getJson(app, "/dashboard/benchmarks");

    expect(status).toBe(200);
    expect(json.cpl).toBe(100); // 10000 spend / 100 leads
    expect(json.bookingRate).toBe(40); // 40 / 100 * 100
    expect(json.closeRate).toBe(50); // 20 booked-with-invoice / 40 booked * 100
    expect(json.avgSaleValue).toBe(2000); // 50000 revenue / 25 invoiced jobs
    expect(json.roas).toBe(5); // 50000 revenue / 10000 spend
  });

  it("returns zeroed metrics when there is no lead, job or spend activity", async () => {
    seed({
      totalLeads: 0,
      bookedLeads: 0,
      soldLeads: 0,
      revenue: 0,
      invoicedJobCount: 0,
      spend: 0,
      bookedWithInvoice: 0,
    });

    const app = await setupApp("super_admin");
    const { status, json } = await getJson(app, "/dashboard/benchmarks");

    expect(status).toBe(200);
    expect(json.cpl).toBe(0);
    expect(json.bookingRate).toBe(0);
    expect(json.closeRate).toBe(0);
    expect(json.avgSaleValue).toBe(0);
    expect(json.roas).toBe(0);
  });

  it("falls back to soldLeads for avgSaleValue when no jobs are invoiced", async () => {
    // invoicedJobCount = 0 forces the soldLeads denominator branch.
    seed({
      totalLeads: 50,
      bookedLeads: 20,
      soldLeads: 4,
      revenue: 8000,
      invoicedJobCount: 0,
      spend: 5000,
      bookedWithInvoice: 0,
    });

    const app = await setupApp("super_admin");
    const { status, json } = await getJson(app, "/dashboard/benchmarks");

    expect(status).toBe(200);
    expect(json.avgSaleValue).toBe(2000); // 8000 revenue / 4 sold leads
  });
});

// /dashboard/benchmarks scopes every leads/jobs/spend query to active tenants
// via `inArray(<table>.tenantId, db.select({ id }).from(tenantsTable).where(
// eq(tenantsTable.isActive, true)))`. A deactivated client's leads, jobs and
// spend are filtered out in SQL before they ever reach the aggregates, so they
// can never contribute to the returned benchmark numbers. Because the mock does
// not execute SQL, the seeded aggregates already represent the active-only
// totals the real subquery would yield; the `drizzle.eq(tenantsTable.isActive,
// true)` assertion is the regression guard — if a refactor drops the isActive
// filter, that expectation fails immediately. Mirrors the active-tenant scoping
// suites in admin-leaderboard.test.ts, admin-dashboard-stats.test.ts and
// dashboard-cross-tenant-overview.test.ts.
describe("GET /dashboard/benchmarks — active-tenant scoping", () => {
  beforeEach(() => {
    mockDb.reset();
    drizzle.eq.mockClear();
  });

  it("scopes every benchmark query to active tenants, excluding deactivated clients", async () => {
    // The aggregates carry the active-only totals (a deactivated Zombie's far
    // larger leads/jobs/spend are filtered out by the isActive subquery before
    // aggregation, so they never appear here).
    seed({
      totalLeads: 100,
      bookedLeads: 40,
      soldLeads: 20,
      revenue: 50000,
      invoicedJobCount: 25,
      spend: 10000,
      bookedWithInvoice: 20,
    });

    const app = await setupApp("super_admin");
    const { status, json } = await getJson(app, "/dashboard/benchmarks");

    expect(status).toBe(200);

    // Regression guard: every benchmark query must restrict the tenant set with
    // `WHERE isActive = true`. The endpoint builds this filter for the lead,
    // job, spend and close-rate queries alike.
    expect(drizzle.eq).toHaveBeenCalledWith("tenants.isActive", true);

    // The returned metrics reflect only the active-tenant aggregates; the
    // inactive client's numbers never leak into cpl/roas/etc.
    expect(json.cpl).toBe(100);
    expect(json.roas).toBe(5);
    expect(json.bookingRate).toBe(40);
    expect(json.closeRate).toBe(50);
    expect(json.avgSaleValue).toBe(2000);
  });
});
