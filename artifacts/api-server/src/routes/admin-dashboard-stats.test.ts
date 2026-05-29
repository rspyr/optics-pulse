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
