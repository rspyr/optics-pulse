import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { type Request, type Response, type NextFunction } from "express";
import http from "http";

// Minimal db.select() chain. Every select call shifts the next queued result
// off `state.selectQueue`. The chain is thenable after `.from().where()`, which
// covers every select issued by `/admin/dashboard-stats` (tenants, then per
// tenant: leads, jobs, campaigns, and — only when campaigns exist — spend).
const state = {
  selectQueue: [] as unknown[][],
  reset() {
    this.selectQueue = [];
  },
};

function makeSelectChain(): Record<string, unknown> {
  const resolveResult = () =>
    Promise.resolve(state.selectQueue.length ? state.selectQueue.shift() : []);
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn().mockReturnValue(chain);
  chain.innerJoin = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockReturnValue(chain);
  chain.then = (r: Function) => resolveResult().then(r as (v: unknown) => unknown);
  return chain;
}

const tableProxy = (name: string) =>
  new Proxy({}, { get: (_t, prop) => `${name}.${String(prop)}` });

vi.mock("@workspace/db", () => ({
  db: {
    select: vi.fn().mockImplementation(() => makeSelectChain()),
  },
  pool: {},
  usersTable: tableProxy("users"),
  tenantsTable: tableProxy("tenants"),
  leadsTable: tableProxy("leads"),
  jobsTable: tableProxy("jobs"),
  campaignsTable: tableProxy("campaigns"),
  campaignDailyStatsTable: tableProxy("campaign_daily_stats"),
  trainingPurchasesTable: tableProxy("training_purchases"),
  trainingItemsTable: tableProxy("training_items"),
}));

// Shared, stable drizzle-orm spies. They must survive the vi.resetModules() in
// setupApp so that, after admin.ts is re-imported, the route still calls the
// *same* gte/lte mocks the tests inspect. vi.hoisted gives us that stable
// reference; an inline factory would mint fresh fns on every re-import.
const drizzle = vi.hoisted(() => {
  const sql = Object.assign((...a: unknown[]) => a, {
    join: (...a: unknown[]) => a,
  });
  return {
    eq: vi.fn((...a: unknown[]) => a),
    and: vi.fn((...a: unknown[]) => a),
    gte: vi.fn((...a: unknown[]) => a),
    lte: vi.fn((...a: unknown[]) => a),
    count: vi.fn((...a: unknown[]) => a),
    sum: vi.fn((...a: unknown[]) => a),
    avg: vi.fn((...a: unknown[]) => a),
    inArray: vi.fn((...a: unknown[]) => a),
    sql,
  };
});

vi.mock("drizzle-orm", () => drizzle);

vi.mock("../middleware/auth", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireRole:
    (...roles: string[]) =>
    (
      req: { session?: { userRole?: string } },
      res: { status: (n: number) => { json: (b: unknown) => void } },
      next: () => void,
    ) => {
      if (roles.includes(req.session?.userRole ?? "")) return next();
      res.status(403).json({ error: "Insufficient permissions" });
    },
}));

// admin.ts pulls these in at module load; stub them so importing the route
// doesn't drag in real service side effects.
vi.mock("../services/sync-scheduler", () => ({
  backfillMetaAdCreatives: vi.fn(),
}));
vi.mock("../services/broken-account-audit", () => ({
  findUsersWithoutTenant: vi.fn(),
}));
vi.mock("../services/backfill-default-funnel", () => ({
  backfillDefaultFunnelForTenant: vi.fn(),
}));
vi.mock("../services/one-time-migrations", () => ({
  backfillManualSourceForLegacyEvents: vi.fn(),
  BACKFILL_MANUAL_SOURCE_MIGRATION_ID: "manual_source_backfill",
}));

async function setupApp(role: string) {
  vi.resetModules();
  const mod = await import("./admin");
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
    const server = http.createServer(app);
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      const req = http.request(
        { hostname: "127.0.0.1", port, path, method: "GET" },
        (res: { statusCode?: number; on: Function }) => {
          let data = "";
          res.on("data", (chunk: string) => (data += chunk));
          res.on("end", () => {
            server.close();
            resolve({
              status: res.statusCode || 0,
              json: data ? JSON.parse(data) : {},
            });
          });
        },
      );
      req.end();
    });
  });
}

// Select order inside the endpoint: [0]=active tenants, then per tenant
// [leads, jobs, campaigns] (no spend select fires when campaigns is empty).
function seedTwoTenants() {
  state.selectQueue = [
    [
      { id: 1, name: "Alpha", monthlyBudget: 8000 },
      { id: 2, name: "Beta", monthlyBudget: null },
    ],
    [], // tenant 1 leads
    [], // tenant 1 jobs
    [], // tenant 1 campaigns
    [], // tenant 2 leads
    [], // tenant 2 jobs
    [], // tenant 2 campaigns
  ];
}

describe("GET /admin/dashboard-stats — budget", () => {
  beforeEach(() => {
    state.reset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("returns each tenant's real monthlyBudget", async () => {
    seedTwoTenants();
    const app = await setupApp("super_admin");
    const { status, json } = await getJson(app, "/admin/dashboard-stats");

    expect(status).toBe(200);
    const tenants = json.tenants as Array<Record<string, number | string>>;
    const alpha = tenants.find((t) => t.tenantId === 1)!;
    expect(alpha.monthlyBudget).toBe(8000); // real per-tenant budget
  });

  it("falls back to the default (15000) when monthly_budget is NULL", async () => {
    seedTwoTenants();
    const app = await setupApp("super_admin");
    const { status, json } = await getJson(app, "/admin/dashboard-stats");

    expect(status).toBe(200);
    const tenants = json.tenants as Array<Record<string, number | string>>;
    const beta = tenants.find((t) => t.tenantId === 2)!;
    expect(beta.monthlyBudget).toBe(15000); // null budget falls back to default
  });
});

// A single tenant that exercises every money/rate path: campaigns with a
// spend row, a mix of lead statuses, and completed/non-completed jobs.
// Select order: [tenants, leads, jobs, campaigns, spend].
//   spend = 1000
//   leads = 10 total → 2 sold + 2 booked = 4 booked, 2 sold
//   jobs  = 5000 completed revenue (the in_progress 9999 is ignored)
// Derived: cpl 100, bookingRate 40.0, closeRate 50.0, roas 5, mtdRevenue 5000.
function seedRichTenant() {
  state.selectQueue = [
    [{ id: 1, name: "Alpha", monthlyBudget: 10000 }],
    [
      { status: "sold" },
      { status: "sold" },
      { status: "booked" },
      { status: "booked" },
      { status: "new" },
      { status: "new" },
      { status: "new" },
      { status: "new" },
      { status: "new" },
      { status: "new" },
    ],
    [
      { status: "completed", revenue: 2500 },
      { status: "completed", revenue: 2500 },
      { status: "in_progress", revenue: 9999 },
    ],
    [{ id: 101 }],
    [{ total: 1000 }],
  ];
}

describe("GET /admin/dashboard-stats — money & rate math", () => {
  beforeEach(() => {
    state.reset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("aggregates mtdSpend from the campaign spend rows", async () => {
    seedRichTenant();
    const app = await setupApp("super_admin");
    const { status, json } = await getJson(app, "/admin/dashboard-stats");

    expect(status).toBe(200);
    const tenants = json.tenants as Array<Record<string, number>>;
    const alpha = tenants.find((t) => t.tenantId === 1)!;
    expect(alpha.mtdSpend).toBe(1000); // summed from campaign_daily_stats
  });

  it("computes mtdRevenue, cpl, bookingRate, closeRate and roas from real leads/jobs", async () => {
    seedRichTenant();
    const app = await setupApp("super_admin");
    const { status, json } = await getJson(app, "/admin/dashboard-stats");

    expect(status).toBe(200);
    const tenants = json.tenants as Array<Record<string, number>>;
    const alpha = tenants.find((t) => t.tenantId === 1)!;

    expect(alpha.mtdRevenue).toBe(5000); // only completed jobs count
    expect(alpha.totalLeads).toBe(10);
    expect(alpha.bookedLeads).toBe(4); // booked + sold
    expect(alpha.soldLeads).toBe(2);
    expect(alpha.cpl).toBe(100); // 1000 spend / 10 leads
    expect(alpha.bookingRate).toBe(40); // 4/10 → 40.0%
    expect(alpha.closeRate).toBe(50); // 2/4 → 50.0%
    expect(alpha.roas).toBe(5); // 5000 revenue / 1000 spend
  });
});

// Two tenants, both with real data, so agency-wide rollups have something to
// average. Select order: [tenants, then per tenant leads, jobs, campaigns, spend].
//   tenant 1: spend 1000, leads 10 (5 booked), revenue 4000
//   tenant 2: spend 1000, leads 10 (5 booked), revenue 6000
// Agency: totalSpend 2000, totalLeads 20, totalRevenue 10000, totalBooked 10.
function seedTwoRichTenants() {
  const tenOf = (booked: number) =>
    Array.from({ length: 10 }, (_, i) => ({
      status: i < booked ? "booked" : "new",
    }));
  state.selectQueue = [
    [
      { id: 1, name: "Alpha", monthlyBudget: 10000 },
      { id: 2, name: "Beta", monthlyBudget: 20000 },
    ],
    tenOf(5), // tenant 1 leads
    [{ status: "completed", revenue: 4000 }], // tenant 1 jobs
    [{ id: 101 }], // tenant 1 campaigns
    [{ total: 1000 }], // tenant 1 spend
    tenOf(5), // tenant 2 leads
    [{ status: "completed", revenue: 6000 }], // tenant 2 jobs
    [{ id: 201 }], // tenant 2 campaigns
    [{ total: 1000 }], // tenant 2 spend
  ];
}

describe("GET /admin/dashboard-stats — agency averages", () => {
  beforeEach(() => {
    state.reset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("computes agencyAverages across all active tenants even when tenantId filtering is applied", async () => {
    seedTwoRichTenants();
    const app = await setupApp("super_admin");
    const { status, json } = await getJson(
      app,
      "/admin/dashboard-stats?tenantId=1",
    );

    expect(status).toBe(200);

    // The displayed tenant list is scoped to the requested tenant...
    const tenants = json.tenants as Array<Record<string, number>>;
    expect(tenants).toHaveLength(1);
    expect(tenants[0].tenantId).toBe(1);

    // ...but the agency benchmark still spans BOTH active tenants.
    const avg = json.agencyAverages as Record<string, number>;
    expect(avg.totalLeads).toBe(20); // 10 + 10
    expect(avg.totalSpend).toBe(2000); // 1000 + 1000
    expect(avg.totalRevenue).toBe(10000); // 4000 + 6000
    expect(avg.cpl).toBe(100); // 2000 / 20
    expect(avg.roas).toBe(5); // 10000 / 2000
    expect(avg.bookingRate).toBe(50); // 10 booked / 20 leads
  });
});

// projectedSpend extrapolates month-to-date spend to the full month:
//   Math.round((mtdSpend / dayOfMonth) * daysInMonth)
// This depends on "today", so we pin the system clock to make it deterministic.
// We fake ONLY Date (not all timers) so the real http server timers keep
// working and getJson doesn't hang.
describe("GET /admin/dashboard-stats — projected spend", () => {
  beforeEach(() => {
    state.reset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("extrapolates mtdSpend to month-end from the day/days-in-month ratio", async () => {
    // May 15 of a 31-day month: 1000 / 15 * 31 = 2066.67 → rounds to 2067.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 4, 15, 12, 0, 0));

    seedRichTenant();
    const app = await setupApp("super_admin");
    const { status, json } = await getJson(app, "/admin/dashboard-stats");

    expect(status).toBe(200);
    const tenants = json.tenants as Array<Record<string, number>>;
    const alpha = tenants.find((t) => t.tenantId === 1)!;
    expect(alpha.mtdSpend).toBe(1000);
    expect(alpha.projectedSpend).toBe(2067); // round(1000 / 15 * 31)
  });

  it("projects close to mtdSpend on the last day of the month", async () => {
    // May 31 (last day): 1000 / 31 * 31 = 1000.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 4, 31, 12, 0, 0));

    seedRichTenant();
    const app = await setupApp("super_admin");
    const { status, json } = await getJson(app, "/admin/dashboard-stats");

    expect(status).toBe(200);
    const tenants = json.tenants as Array<Record<string, number>>;
    const alpha = tenants.find((t) => t.tenantId === 1)!;
    expect(alpha.projectedSpend).toBe(1000); // round(1000 / 31 * 31)
  });
});

// overBudget flags a client whose extrapolated full-month spend will blow past
// their monthlyBudget. It is derived as projectedSpend > monthlyBudget, so we
// pin the clock (projectedSpend depends on "today") and pair a tiny budget with
// a generous one to exercise both sides of the comparison.
// Select order: [tenants, then per tenant leads, jobs, campaigns, spend].
//   tenant 1 (Tight): budget 100, spend 1000 → projected 2067 → over budget
//   tenant 2 (Roomy): budget 100000, spend 1000 → projected 2067 → under budget
function seedBudgetContrastTenants() {
  state.selectQueue = [
    [
      { id: 1, name: "Tight", monthlyBudget: 100 },
      { id: 2, name: "Roomy", monthlyBudget: 100000 },
    ],
    [], // tenant 1 leads
    [], // tenant 1 jobs
    [{ id: 101 }], // tenant 1 campaigns
    [{ total: 1000 }], // tenant 1 spend
    [], // tenant 2 leads
    [], // tenant 2 jobs
    [{ id: 201 }], // tenant 2 campaigns
    [{ total: 1000 }], // tenant 2 spend
  ];
}

describe("GET /admin/dashboard-stats — over budget warning", () => {
  beforeEach(() => {
    state.reset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("flags overBudget when projectedSpend exceeds monthlyBudget", async () => {
    // May 15 of a 31-day month: 1000 / 15 * 31 = 2066.67 → projects to 2067.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 4, 15, 12, 0, 0));

    seedBudgetContrastTenants();
    const app = await setupApp("super_admin");
    const { status, json } = await getJson(app, "/admin/dashboard-stats");

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
  });

  it("does not flag overBudget when projectedSpend equals monthlyBudget", async () => {
    // May 31 (last day): 1000 / 31 * 31 = 1000, equal to the 1000 budget.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 4, 31, 12, 0, 0));

    state.selectQueue = [
      [{ id: 1, name: "Exact", monthlyBudget: 1000 }],
      [], // leads
      [], // jobs
      [{ id: 101 }], // campaigns
      [{ total: 1000 }], // spend
    ];

    const app = await setupApp("super_admin");
    const { status, json } = await getJson(app, "/admin/dashboard-stats");

    expect(status).toBe(200);
    const tenants = json.tenants as Array<Record<string, number | boolean>>;
    const exact = tenants.find((t) => t.tenantId === 1)!;
    expect(exact.projectedSpend).toBe(1000);
    expect(exact.monthlyBudget).toBe(1000);
    expect(exact.overBudget).toBe(false); // strictly greater, so equal is not over
  });
});

// pacePercent expresses projectedSpend as a percentage of monthlyBudget
// (projectedSpend / monthlyBudget * 100, one decimal). overPace is pacePercent
// > 110 and underPace is pacePercent < 85, so we pin the clock (projectedSpend
// depends on "today") and contrast a tiny budget (way over pace) with a
// generous one (well under pace).
// Select order: [tenants, then per tenant leads, jobs, campaigns, spend].
//   tenant 1 (Hot):  budget 1000, spend 1000 → projected 2067 → pace 206.7 → over
//   tenant 2 (Cold): budget 100000, spend 1000 → projected 2067 → pace 2.1 → under
function seedPaceContrastTenants() {
  state.selectQueue = [
    [
      { id: 1, name: "Hot", monthlyBudget: 1000 },
      { id: 2, name: "Cold", monthlyBudget: 100000 },
    ],
    [], // tenant 1 leads
    [], // tenant 1 jobs
    [{ id: 101 }], // tenant 1 campaigns
    [{ total: 1000 }], // tenant 1 spend
    [], // tenant 2 leads
    [], // tenant 2 jobs
    [{ id: 201 }], // tenant 2 campaigns
    [{ total: 1000 }], // tenant 2 spend
  ];
}

describe("GET /admin/dashboard-stats — budget pace badges", () => {
  beforeEach(() => {
    state.reset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns pacePercent and flags overPace / underPace per tenant", async () => {
    // May 15 of a 31-day month: 1000 / 15 * 31 = 2066.67 → projects to 2067.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 4, 15, 12, 0, 0));

    seedPaceContrastTenants();
    const app = await setupApp("super_admin");
    const { status, json } = await getJson(app, "/admin/dashboard-stats");

    expect(status).toBe(200);
    const tenants = json.tenants as Array<Record<string, number | boolean>>;

    const hot = tenants.find((t) => t.tenantId === 1)!;
    expect(hot.pacePercent).toBe(206.7); // 2067 / 1000 * 100
    expect(hot.overPace).toBe(true); // 206.7 > 110
    expect(hot.underPace).toBe(false);

    const cold = tenants.find((t) => t.tenantId === 2)!;
    expect(cold.pacePercent).toBe(2.1); // 2067 / 100000 * 100 → 2.067 → 2.1
    expect(cold.overPace).toBe(false);
    expect(cold.underPace).toBe(true); // 2.1 < 85
  });

  it("does not flag overPace or underPace when pace sits in the 85–110 band", async () => {
    // May 31 (last day): 1000 / 31 * 31 = 1000 projected. budget 1000 → pace 100.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 4, 31, 12, 0, 0));

    state.selectQueue = [
      [{ id: 1, name: "OnPace", monthlyBudget: 1000 }],
      [], // leads
      [], // jobs
      [{ id: 101 }], // campaigns
      [{ total: 1000 }], // spend
    ];

    const app = await setupApp("super_admin");
    const { status, json } = await getJson(app, "/admin/dashboard-stats");

    expect(status).toBe(200);
    const tenants = json.tenants as Array<Record<string, number | boolean>>;
    const onPace = tenants.find((t) => t.tenantId === 1)!;
    expect(onPace.pacePercent).toBe(100); // 1000 / 1000 * 100
    expect(onPace.overPace).toBe(false);
    expect(onPace.underPace).toBe(false);
  });
});

describe("GET /admin/dashboard-stats — date range narrowing", () => {
  beforeEach(() => {
    state.reset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("wires startDate/endDate into the lead, job and spend query windows", async () => {
    seedRichTenant();
    const app = await setupApp("super_admin");

    // Only the request (not module load) calls gte/lte, so clearing here gives
    // us a clean record of exactly the conditions this query builds.
    drizzle.gte.mockClear();
    drizzle.lte.mockClear();

    const { status } = await getJson(
      app,
      "/admin/dashboard-stats?startDate=2026-05-01&endDate=2026-05-28",
    );

    expect(status).toBe(200);

    // Lead and job windows use Date-bounded createdAt.
    expect(drizzle.gte).toHaveBeenCalledWith(
      "leads.createdAt",
      expect.any(Date),
    );
    expect(drizzle.gte).toHaveBeenCalledWith("jobs.createdAt", expect.any(Date));
    expect(drizzle.lte).toHaveBeenCalledWith(
      "leads.createdAt",
      expect.any(Date),
    );
    expect(drizzle.lte).toHaveBeenCalledWith("jobs.createdAt", expect.any(Date));

    // Spend window narrows campaign_daily_stats by its string date column.
    expect(drizzle.gte).toHaveBeenCalledWith(
      "campaign_daily_stats.date",
      "2026-05-01",
    );
    expect(drizzle.lte).toHaveBeenCalledWith(
      "campaign_daily_stats.date",
      "2026-05-28",
    );
  });
});

// /admin/dashboard-stats only aggregates tenants where isActive = true (the
// route loads the tenant list with `WHERE isActive = true`, then fans per-tenant
// leads/jobs/spend queries over that list). A deactivated client must not show
// up in the per-tenant `tenants` array nor leak into the agency-wide rollups.
// The tenant-list select returns only active rows — exactly what the real filter
// yields — so the inactive tenant has no per-tenant queue entries and never gets
// queried. The `drizzle.eq(tenantsTable.isActive, true)` assertion is the
// regression guard: if a refactor drops the isActive filter, that expectation
// fails immediately. Mirrors the active-tenant scoping suite in
// admin-leaderboard.test.ts.
describe("GET /admin/dashboard-stats — active-tenant scoping", () => {
  beforeEach(() => {
    state.reset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("excludes inactive tenants from the per-tenant list and agency rollups", async () => {
    // Active Alpha and Beta each contribute leads/jobs/spend. The deactivated
    // Zombie (id 3) carries far larger revenue/spend in the underlying tables,
    // but the active-only tenant list never includes it, so it is never queried
    // and never reaches the output. We mirror seedTwoRichTenants: the tenant
    // list returns only the two active rows, followed by their per-tenant
    // leads/jobs/campaigns/spend results.
    const tenOf = (booked: number) =>
      Array.from({ length: 10 }, (_, i) => ({
        status: i < booked ? "booked" : "new",
      }));
    state.selectQueue = [
      // Active-tenant list (WHERE isActive = true) — Zombie deliberately absent.
      [
        { id: 1, name: "Alpha", monthlyBudget: 10000 },
        { id: 2, name: "Beta", monthlyBudget: 20000 },
      ],
      tenOf(5), // tenant 1 leads
      [{ status: "completed", revenue: 4000 }], // tenant 1 jobs
      [{ id: 101 }], // tenant 1 campaigns
      [{ total: 1000 }], // tenant 1 spend
      tenOf(5), // tenant 2 leads
      [{ status: "completed", revenue: 6000 }], // tenant 2 jobs
      [{ id: 201 }], // tenant 2 campaigns
      [{ total: 1000 }], // tenant 2 spend
    ];

    const app = await setupApp("super_admin");
    const { status, json } = await getJson(app, "/admin/dashboard-stats");

    expect(status).toBe(200);

    // The route must scope the tenant list with `WHERE isActive = true`.
    expect(drizzle.eq).toHaveBeenCalledWith("tenants.isActive", true);

    // Only the two active tenants surface; the deactivated Zombie never does.
    const tenants = json.tenants as Array<Record<string, number>>;
    expect(tenants).toHaveLength(2);
    expect(tenants.map((t) => t.tenantId).sort()).toEqual([1, 2]);
    expect(tenants.some((t) => t.tenantId === 3)).toBe(false);

    // Agency rollups span the active tenants only: 4000 + 6000 revenue, not the
    // inactive tenant's larger figures.
    const avg = json.agencyAverages as Record<string, number>;
    expect(avg.totalLeads).toBe(20); // 10 + 10
    expect(avg.totalSpend).toBe(2000); // 1000 + 1000
    expect(avg.totalRevenue).toBe(10000); // 4000 + 6000
  });
});
