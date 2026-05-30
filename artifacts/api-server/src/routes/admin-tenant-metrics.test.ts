import { describe, it, expect, vi, beforeEach } from "vitest";

// computeTenantMetrics powers the per-client drilldown and the leaderboard. It
// is exercised here in isolation so its money/rate math can drift independently
// of the /admin/dashboard-stats route it mirrors.
//
// Minimal db.select() chain. Every select call shifts the next queued result
// off `state.selectQueue`. The chain is thenable after `.from()/.innerJoin()/
// .where()/.groupBy()`, which covers every select issued by the batch helper
// computeTenantMetrics now delegates to: three grouped queries fired in
// Promise.all order — leads, jobs, then spend.
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
  chain.groupBy = vi.fn().mockReturnValue(chain);
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
// loadComputeTenantMetrics so that, after admin.ts is re-imported, the helper
// still calls the *same* gte/lte mocks the tests inspect. vi.hoisted gives us
// that stable reference; an inline factory would mint fresh fns on every import.
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

async function loadComputeTenantMetrics() {
  vi.resetModules();
  const mod = await import("./admin");
  return mod.computeTenantMetrics;
}

// A tenant that exercises every money/rate path. The batch helper aggregates in
// SQL, so each query returns a single grouped row keyed by tenantId rather than
// raw rows counted in JS.
// Select order inside the batch helper (Promise.all): [leads, jobs, spend].
//   leads = 10 total, 4 booked (booked + sold), 2 sold
//   jobs  = 5000 completed revenue
//   spend = 1000
// Derived: cpl 100, bookingRate 40.0, closeRate 50.0, roas 5, revenue 5000.
function seedRichTenant() {
  state.selectQueue = [
    [{ tenantId: 1, totalLeads: 10, bookedLeads: 4, soldLeads: 2 }], // leads
    [{ tenantId: 1, revenue: 5000 }], // jobs
    [{ tenantId: 1, total: 1000 }], // spend
  ];
}

describe("computeTenantMetrics — money & rate math", () => {
  beforeEach(() => {
    state.reset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("aggregates spend from the campaign spend rows", async () => {
    const compute = await loadComputeTenantMetrics();
    seedRichTenant();

    const m = await compute(1, "2026-05-01", "2026-05-28");
    expect(m.spend).toBe(1000); // summed from campaign_daily_stats
  });

  it("counts revenue only from completed jobs", async () => {
    const compute = await loadComputeTenantMetrics();
    seedRichTenant();

    const m = await compute(1, "2026-05-01", "2026-05-28");
    expect(m.revenue).toBe(5000); // 2500 + 2500; in_progress 9999 ignored
  });

  it("derives lead counts and the close/booking/cpl/roas rates", async () => {
    const compute = await loadComputeTenantMetrics();
    seedRichTenant();

    const m = await compute(1, "2026-05-01", "2026-05-28");
    expect(m.totalLeads).toBe(10);
    expect(m.bookedLeads).toBe(4); // booked + sold
    expect(m.soldLeads).toBe(2);
    expect(m.cpl).toBe(100); // 1000 spend / 10 leads
    expect(m.bookingRate).toBe(40); // 4/10 → 40.0%
    expect(m.closeRate).toBe(50); // 2/4 → 50.0%
    expect(m.roas).toBe(5); // 5000 revenue / 1000 spend
  });

  it("zeroes spend-derived rates when the tenant has no campaign spend", async () => {
    const compute = await loadComputeTenantMetrics();
    // No spend rows → the grouped spend query returns empty. Order still fires
    // all three: [leads, jobs, spend].
    state.selectQueue = [
      [{ tenantId: 1, totalLeads: 2, bookedLeads: 1, soldLeads: 0 }], // leads
      [{ tenantId: 1, revenue: 3000 }], // jobs
      [], // spend (empty → spend 0)
    ];

    const m = await compute(1, "2026-05-01", "2026-05-28");
    expect(m.spend).toBe(0);
    expect(m.cpl).toBe(0); // no spend → cpl 0
    expect(m.roas).toBe(0); // no spend → roas 0
    expect(m.revenue).toBe(3000);
    expect(m.bookingRate).toBe(50); // 1 booked / 2 leads
  });
});

describe("computeTenantMetrics — date-boundary expansion", () => {
  beforeEach(() => {
    state.reset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("expands startDate/endDate to full-day UTC boundaries on the lead and job windows", async () => {
    const compute = await loadComputeTenantMetrics();
    state.selectQueue = [
      [], // leads
      [], // jobs
      [], // spend
    ];

    drizzle.gte.mockClear();
    drizzle.lte.mockClear();

    await compute(1, "2026-05-01", "2026-05-28");

    // Lead/job windows expand to the start and end of the UTC day.
    expect(drizzle.gte).toHaveBeenCalledWith(
      "leads.createdAt",
      new Date("2026-05-01T00:00:00.000Z"),
    );
    expect(drizzle.gte).toHaveBeenCalledWith(
      "jobs.createdAt",
      new Date("2026-05-01T00:00:00.000Z"),
    );
    expect(drizzle.lte).toHaveBeenCalledWith(
      "leads.createdAt",
      new Date("2026-05-28T23:59:59.999Z"),
    );
    expect(drizzle.lte).toHaveBeenCalledWith(
      "jobs.createdAt",
      new Date("2026-05-28T23:59:59.999Z"),
    );

    // The spend window, by contrast, narrows on the raw string date column.
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
