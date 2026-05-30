import { describe, it, expect, vi, beforeEach } from "vitest";

// Minimal db.select() chain that supports the shapes used by the
// cross-tenant-overview endpoint:
//   from().where()                      -> thenable (active tenants)
//   from().where().groupBy()            -> leads / jobs aggregates
//   from().innerJoin().where().groupBy() -> spend aggregate
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

// Select call order inside the endpoint: [0]=active tenants, [1]=leads,
// [2]=jobs, [3]=spend.
function seed() {
  mockDb.selectResults = [
    [
      { id: 1, name: "Alpha", monthlyBudget: 5000 },
      { id: 2, name: "Beta", monthlyBudget: null },
    ],
    [{ tenantId: 1, totalLeads: 10, bookedLeads: 4, soldLeads: 2 }],
    [{ tenantId: 1, mtdRevenue: 1000 }],
    [{ tenantId: 1, total: 200 }],
  ];
}

describe("GET /dashboard/cross-tenant-overview", () => {
  beforeEach(() => {
    mockDb.reset();
  });

  it("aggregates per-tenant rows and agency averages for super_admin", async () => {
    seed();
    const app = await setupApp("super_admin");
    const { status, json } = await getJson(app, "/dashboard/cross-tenant-overview");

    expect(status).toBe(200);
    expect(json.dateRange).toBeTruthy();

    const tenants = json.tenants as Array<Record<string, number | string>>;
    expect(tenants).toHaveLength(2);

    const alpha = tenants.find((t) => t.tenantId === 1)!;
    expect(alpha.tenantName).toBe("Alpha");
    expect(alpha.mtdSpend).toBe(200);
    expect(alpha.mtdRevenue).toBe(1000);
    expect(alpha.totalLeads).toBe(10);
    expect(alpha.cpl).toBe(20); // 200 / 10
    expect(alpha.bookingRate).toBe(40); // 4 / 10 * 100
    expect(alpha.roas).toBe(5); // 1000 / 200
    expect(alpha.monthlyBudget).toBe(5000); // real per-tenant budget

    const beta = tenants.find((t) => t.tenantId === 2)!;
    expect(beta.totalLeads).toBe(0);
    expect(beta.mtdSpend).toBe(0);
    expect(beta.roas).toBe(0);
    expect(beta.monthlyBudget).toBe(15000); // null budget falls back to default

    const avg = json.agencyAverages as Record<string, number>;
    expect(avg.totalSpend).toBe(200);
    expect(avg.totalRevenue).toBe(1000);
    expect(avg.totalLeads).toBe(10);
    expect(avg.cpl).toBe(20);
    expect(avg.roas).toBe(5);
  });

  it("allows agency_user", async () => {
    seed();
    const app = await setupApp("agency_user");
    const { status } = await getJson(app, "/dashboard/cross-tenant-overview");
    expect(status).toBe(200);
  });

  it("forbids non-privileged roles", async () => {
    seed();
    const app = await setupApp("tenant_admin");
    const { status } = await getJson(app, "/dashboard/cross-tenant-overview");
    expect(status).toBe(403);
  });

  it("returns a backend-driven overBudget flag per tenant", async () => {
    // May 15 of a 31-day month: a tenant spending 1000 MTD projects to
    // 1000 / 15 * 31 = 2067. Pair a tiny budget (over) and a roomy one (under).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 4, 15, 12, 0, 0));
    try {
      mockDb.selectResults = [
        [
          { id: 1, name: "Tight", monthlyBudget: 100 },
          { id: 2, name: "Roomy", monthlyBudget: 100000 },
        ],
        [], // leads
        [], // jobs
        [
          { tenantId: 1, total: 1000 },
          { tenantId: 2, total: 1000 },
        ],
      ];

      const app = await setupApp("super_admin");
      const { status, json } = await getJson(app, "/dashboard/cross-tenant-overview");
      expect(status).toBe(200);

      const tenants = json.tenants as Array<Record<string, number | boolean>>;
      const tight = tenants.find((t) => t.tenantId === 1)!;
      expect(tight.projectedSpend).toBe(2067);
      expect(tight.monthlyBudget).toBe(100);
      expect(tight.overBudget).toBe(true); // 2067 > 100

      const roomy = tenants.find((t) => t.tenantId === 2)!;
      expect(roomy.projectedSpend).toBe(2067);
      expect(roomy.monthlyBudget).toBe(100000);
      expect(roomy.overBudget).toBe(false); // 2067 < 100000
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns backend-driven pace indicators per tenant", async () => {
    // May 15 of a 31-day month: 1000 MTD projects to 2067.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 4, 15, 12, 0, 0));
    try {
      mockDb.selectResults = [
        [
          { id: 1, name: "OverPace", monthlyBudget: 1000 },
          { id: 2, name: "UnderPace", monthlyBudget: 100000 },
          { id: 3, name: "OnPace", monthlyBudget: 2067 },
        ],
        [], // leads
        [], // jobs
        [
          { tenantId: 1, total: 1000 },
          { tenantId: 2, total: 1000 },
          { tenantId: 3, total: 1000 },
        ],
      ];

      const app = await setupApp("super_admin");
      const { status, json } = await getJson(app, "/dashboard/cross-tenant-overview");
      expect(status).toBe(200);

      const tenants = json.tenants as Array<Record<string, number | boolean>>;

      // 2067 / 1000 * 100 = 206.7 -> over pace
      const over = tenants.find((t) => t.tenantId === 1)!;
      expect(over.pacePercent).toBe(206.7);
      expect(over.overPace).toBe(true);
      expect(over.underPace).toBe(false);

      // 2067 / 100000 * 100 = 2.1 -> under pace
      const under = tenants.find((t) => t.tenantId === 2)!;
      expect(under.pacePercent).toBe(2.1);
      expect(under.overPace).toBe(false);
      expect(under.underPace).toBe(true);

      // 2067 / 2067 * 100 = 100 -> on pace (neither over nor under)
      const on = tenants.find((t) => t.tenantId === 3)!;
      expect(on.pacePercent).toBe(100);
      expect(on.overPace).toBe(false);
      expect(on.underPace).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("filters the tenants array by tenantId but keeps agency-wide averages", async () => {
    seed();
    const app = await setupApp("super_admin");
    const { status, json } = await getJson(
      app,
      "/dashboard/cross-tenant-overview?tenantId=1",
    );
    expect(status).toBe(200);

    const tenants = json.tenants as Array<Record<string, number>>;
    expect(tenants).toHaveLength(1);
    expect(tenants[0].tenantId).toBe(1);

    // Averages are still computed across every active tenant.
    const avg = json.agencyAverages as Record<string, number>;
    expect(avg.totalSpend).toBe(200);
    expect(avg.totalLeads).toBe(10);
  });
});

// /dashboard/cross-tenant-overview only aggregates tenants where isActive = true
// (the route loads the tenant list with `WHERE isActive = true`, then maps the
// per-tenant leads/jobs/spend aggregates over that list). A deactivated client
// must not appear in the per-tenant `tenants` array nor leak into the agency-wide
// averages. The tenant-list select returns only active rows — exactly what the
// real filter yields — while the grouped metric results still carry rows for the
// inactive tenant; because the route only maps over the active-only list, those
// rows never reach the output. The `drizzle.eq(tenantsTable.isActive, true)`
// assertion is the regression guard: if a refactor drops the isActive filter,
// that expectation fails immediately. Mirrors the active-tenant scoping suites in
// admin-leaderboard.test.ts and admin-dashboard-stats.test.ts.
describe("GET /dashboard/cross-tenant-overview — active-tenant scoping", () => {
  beforeEach(() => {
    mockDb.reset();
    drizzle.eq.mockClear();
  });

  it("excludes inactive tenants from the overview and agency averages", async () => {
    // Active Alpha and Beta surface; the deactivated Zombie (id 3) carries far
    // larger leads/spend/revenue in the underlying tables but is deliberately
    // absent from the active-only tenant list, so it is never mapped into the
    // output. Select order: [0]=active tenants, [1]=leads, [2]=jobs, [3]=spend.
    mockDb.selectResults = [
      // Active-tenant list (WHERE isActive = true) — Zombie deliberately absent.
      [
        { id: 1, name: "Alpha", monthlyBudget: 5000 },
        { id: 2, name: "Beta", monthlyBudget: 5000 },
      ],
      // leads — includes a stray inactive Zombie row that must be ignored.
      [
        { tenantId: 1, totalLeads: 10, bookedLeads: 4, soldLeads: 2 },
        { tenantId: 2, totalLeads: 6, bookedLeads: 3, soldLeads: 1 },
        { tenantId: 3, totalLeads: 9999, bookedLeads: 9999, soldLeads: 9999 },
      ],
      // jobs — Zombie revenue is huge; it must never reach the rollups.
      [
        { tenantId: 1, mtdRevenue: 1000 },
        { tenantId: 2, mtdRevenue: 2000 },
        { tenantId: 3, mtdRevenue: 999999 },
      ],
      // spend — Zombie spend is huge; it must never reach the rollups.
      [
        { tenantId: 1, total: 200 },
        { tenantId: 2, total: 300 },
        { tenantId: 3, total: 888888 },
      ],
    ];

    const app = await setupApp("super_admin");
    const { status, json } = await getJson(app, "/dashboard/cross-tenant-overview");

    expect(status).toBe(200);

    // The route must scope the tenant list with `WHERE isActive = true`.
    expect(drizzle.eq).toHaveBeenCalledWith("tenants.isActive", true);

    // Only the two active tenants surface; the deactivated Zombie never does.
    const tenants = json.tenants as Array<Record<string, number>>;
    expect(tenants).toHaveLength(2);
    expect(tenants.map((t) => t.tenantId).sort()).toEqual([1, 2]);
    expect(tenants.some((t) => t.tenantId === 3)).toBe(false);

    // Agency averages span the active tenants only: 200 + 300 spend, 1000 + 2000
    // revenue, 10 + 6 leads — not the inactive tenant's far larger figures.
    const avg = json.agencyAverages as Record<string, number>;
    expect(avg.totalSpend).toBe(500);
    expect(avg.totalRevenue).toBe(3000);
    expect(avg.totalLeads).toBe(16);
  });

  it("excludes inactive tenants even when filtering to a single client", async () => {
    // Filtering to the deactivated Zombie (id 3) must return no tenant rows: the
    // active-only list never contains it, so the filter matches nothing — a
    // deactivated client cannot be resurrected via the tenantId query param.
    mockDb.selectResults = [
      // Active-tenant list (WHERE isActive = true) — Zombie deliberately absent.
      [
        { id: 1, name: "Alpha", monthlyBudget: 5000 },
        { id: 2, name: "Beta", monthlyBudget: 5000 },
      ],
      [
        { tenantId: 1, totalLeads: 10, bookedLeads: 4, soldLeads: 2 },
        { tenantId: 2, totalLeads: 6, bookedLeads: 3, soldLeads: 1 },
        { tenantId: 3, totalLeads: 9999, bookedLeads: 9999, soldLeads: 9999 },
      ],
      [
        { tenantId: 1, mtdRevenue: 1000 },
        { tenantId: 2, mtdRevenue: 2000 },
        { tenantId: 3, mtdRevenue: 999999 },
      ],
      [
        { tenantId: 1, total: 200 },
        { tenantId: 2, total: 300 },
        { tenantId: 3, total: 888888 },
      ],
    ];

    const app = await setupApp("super_admin");
    const { status, json } = await getJson(
      app,
      "/dashboard/cross-tenant-overview?tenantId=3",
    );

    expect(status).toBe(200);
    expect(drizzle.eq).toHaveBeenCalledWith("tenants.isActive", true);

    // The deactivated tenant yields no rows.
    const tenants = json.tenants as Array<Record<string, number>>;
    expect(tenants).toHaveLength(0);

    // Agency averages still span the active tenants only — the inactive tenant's
    // numbers never appear even though it was the requested filter.
    const avg = json.agencyAverages as Record<string, number>;
    expect(avg.totalSpend).toBe(500);
    expect(avg.totalRevenue).toBe(3000);
    expect(avg.totalLeads).toBe(16);
  });
});
