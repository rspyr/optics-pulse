import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Request, type Response, type NextFunction } from "express";
import http from "http";

// /admin/leaderboard now computes per-client metrics with computeTenantMetricsBatch:
// two grouped passes (current + previous period), each issuing one grouped query
// per table keyed by tenantId, instead of computeTenantMetrics twice per tenant.
// We keep the select-queue mocking style but key each queue by the table passed
// to `.from()`. Within a table, FIFO order is deterministic — the route awaits
// Promise.all([batch(current), batch(previous)]), so current always shifts
// before previous:
//   tenants                -> [callerLookup?, activeTenantsList]
//   leads / jobs /         -> [current_grouped, previous_grouped] (each is a
//   campaign_daily_stats      single grouped result row-set carrying tenantId)
//   training_purchases     -> [allProductsAcrossTenants] (a single grouped
//                             query for every active tenant; each row carries
//                             its own tenantId so the route groups in memory)
// The spend pass selects from campaign_daily_stats (innerJoin campaigns), so its
// queue key is campaign_daily_stats; there is no longer a separate campaigns
// query. An empty queue leaves the products list empty, which the chain handles
// by defaulting to [].
const state = {
  byTable: {} as Record<string, unknown[][]>,
  reset() {
    this.byTable = {};
  },
};

function makeSelectChain(): Record<string, unknown> {
  let table = "";
  const resolveResult = () => {
    const q = state.byTable[table];
    return Promise.resolve(q && q.length ? q.shift() : []);
  };
  const chain: Record<string, unknown> = {};
  // The table proxy returns `${name}.${prop}` for any access, so reading any
  // key off the passed table and splitting on "." recovers the table name.
  chain.from = vi.fn((tbl: Record<string, unknown>) => {
    table = String(tbl.k).split(".")[0];
    return chain;
  });
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

// Shared, stable drizzle-orm spies that survive the vi.resetModules() in
// setupApp so the re-imported route keeps calling the same fns.
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

async function setupApp(role: string, tenantId: number | null = null) {
  vi.resetModules();
  const mod = await import("./admin");
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

type Period = {
  spend?: number;
  leads?: Array<{ status: string }>;
  jobs?: Array<{ status: string; revenue: number }>;
};
// Raw rows as the products select projects them: training_items.title ->
// itemTitle, training_items.category -> itemCategory, plus the purchase's own
// pricePaid / purchasedAt. The route maps these onto {name, category,
// pricePaid, purchasedAt}. The grouped query also selects tenantId so the
// route can bucket each row; seed() attaches it from the owning tenant.
type ProductRow = {
  itemTitle: string;
  itemCategory: string;
  pricePaid: number;
  purchasedAt: string;
};
type TenantCfg = {
  id: number;
  name: string;
  current: Period;
  previous: Period;
  products?: ProductRow[];
};

// Build per-table FIFO queues from tenant configs. The route now aggregates in
// SQL via computeTenantMetricsBatch, so the mock pre-aggregates each period's
// raw leads/jobs/spend into the grouped row-set the real query would return
// (one row per tenant carrying tenantId). The per-period inputs (leads arrays,
// jobs revenue, spend) stay the same; only the emitted shape is grouped.
// callerRow, when present, is the non-agency caller's tenant lookup that the
// route issues before the active-tenant list.
function seed({
  tenants,
  callerRow,
  inactiveTenants = [],
}: {
  tenants: TenantCfg[];
  callerRow?: Record<string, unknown>;
  inactiveTenants?: TenantCfg[];
}) {
  const byTable: Record<string, unknown[][]> = {
    tenants: [],
    campaign_daily_stats: [],
    leads: [],
    jobs: [],
    training_purchases: [],
  };
  if (callerRow) byTable.tenants.push([callerRow]);
  // The route lists tenants with `WHERE isActive = true`, so the active-tenant
  // list query returns only active rows — exactly what the real filter yields.
  // Inactive tenants are deliberately omitted here.
  byTable.tenants.push(tenants.map((t) => ({ id: t.id, name: t.name })));

  // Underlying leads/jobs/spend tables hold rows for inactive tenants too, so
  // seed metric rows for active AND inactive tenants. The route only ever maps
  // over the (active-only) tenant list above, so inactive rows must never reach
  // the rankings — proving the isActive filter, not the mock, scopes the data.
  const metricTenants = [...tenants, ...inactiveTenants];

  // Emit one grouped result per period (current first, then previous), each a
  // row-set spanning every tenant — matching the two batched passes the route
  // runs via Promise.all([batch(current), batch(previous)]).
  for (const period of ["current", "previous"] as const) {
    const leadRows: Array<{ tenantId: number; totalLeads: number; bookedLeads: number; soldLeads: number }> = [];
    const jobRows: Array<{ tenantId: number; revenue: number }> = [];
    const spendRows: Array<{ tenantId: number; total: number }> = [];
    for (const t of metricTenants) {
      const p = t[period];
      const leads = p.leads ?? [];
      const bookedLeads = leads.filter((l) => l.status === "booked" || l.status === "sold").length;
      const soldLeads = leads.filter((l) => l.status === "sold").length;
      const revenue = (p.jobs ?? [])
        .filter((j) => j.status === "completed")
        .reduce((s, j) => s + (j.revenue || 0), 0);
      leadRows.push({ tenantId: t.id, totalLeads: leads.length, bookedLeads, soldLeads });
      jobRows.push({ tenantId: t.id, revenue });
      spendRows.push({ tenantId: t.id, total: p.spend ?? 0 });
    }
    byTable.leads.push(leadRows);
    byTable.jobs.push(jobRows);
    byTable.campaign_daily_stats.push(spendRows);
  }

  // Products are still fetched once for all active tenants in a single grouped
  // query, so flatten every tenant's rows (tagged with their tenantId) into a
  // single result and push it as the lone training_purchases shift.
  const allProducts: Array<ProductRow & { tenantId: number }> = [];
  for (const t of tenants) {
    for (const product of t.products ?? []) {
      allProducts.push({ ...product, tenantId: t.id });
    }
  }
  byTable.training_purchases.push(allProducts);
  state.byTable = byTable;
}

// `n` "new" leads — enough to anchor a total-lead count for cpl math.
const leadsN = (n: number) => Array.from({ length: n }, () => ({ status: "new" }));
// Single completed job carrying `rev`; an empty list means zero revenue.
const jobsRev = (rev: number) =>
  rev > 0 ? [{ status: "completed", revenue: rev }] : [];
const findRank = (json: Record<string, unknown>, tenantId: number) =>
  (json.rankings as Array<Record<string, unknown>>).find(
    (r) => r.tenantId === tenantId,
  )!;

describe("GET /admin/leaderboard — access control", () => {
  beforeEach(() => {
    state.reset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("forbids client_user callers", async () => {
    const app = await setupApp("client_user", 1);
    const { status } = await getJson(app, "/admin/leaderboard");
    expect(status).toBe(403);
  });

  it("rejects an unknown metric", async () => {
    const app = await setupApp("super_admin");
    const { status, json } = await getJson(app, "/admin/leaderboard?metric=foo");
    expect(status).toBe(400);
    expect(String(json.error)).toContain("metric must be one of");
  });

  it("forbids a non-agency caller whose leaderboard is not visible", async () => {
    seed({
      callerRow: { id: 2, name: "Beta", leaderboardConfig: { visible: false } },
      tenants: [{ id: 2, name: "Beta", current: {}, previous: {} }],
    });
    const app = await setupApp("client_admin", 2);
    const { status } = await getJson(app, "/admin/leaderboard?metric=revenue");
    expect(status).toBe(403);
  });
});

describe("GET /admin/leaderboard — trend math", () => {
  beforeEach(() => {
    state.reset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("computes month-over-month trend from current vs previous", async () => {
    seed({
      tenants: [
        {
          id: 1,
          name: "Alpha",
          current: { jobs: jobsRev(6000) },
          previous: { jobs: jobsRev(4000) },
        },
      ],
    });
    const app = await setupApp("super_admin");
    const { status, json } = await getJson(app, "/admin/leaderboard?metric=revenue");

    expect(status).toBe(200);
    const alpha = findRank(json, 1);
    expect(alpha.metricValue).toBe(6000);
    expect(alpha.previousValue).toBe(4000);
    expect(alpha.trend).toBe(50); // (6000-4000)/4000 * 100
  });

  it("falls back when the previous period is zero: 100 if current > 0, else 0", async () => {
    seed({
      tenants: [
        {
          id: 1,
          name: "Alpha",
          current: { jobs: jobsRev(5000) },
          previous: { jobs: jobsRev(0) },
        },
        {
          id: 2,
          name: "Beta",
          current: { jobs: jobsRev(0) },
          previous: { jobs: jobsRev(0) },
        },
      ],
    });
    const app = await setupApp("super_admin");
    const { status, json } = await getJson(app, "/admin/leaderboard?metric=revenue");

    expect(status).toBe(200);
    const alpha = findRank(json, 1);
    expect(alpha.previousValue).toBe(0);
    expect(alpha.trend).toBe(100); // zero previous, positive current

    const beta = findRank(json, 2);
    expect(beta.metricValue).toBe(0);
    expect(beta.trend).toBe(0); // zero previous, zero current
  });
});

describe("GET /admin/leaderboard — sort direction", () => {
  beforeEach(() => {
    state.reset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  // Same tenants, two metrics: revenue is higher-is-better (descending) while
  // cpl is lower-is-better (ascending). The two orderings must invert.
  //   t1: revenue 5000, cpl 100  (spend 1000 / 10 leads)
  //   t2: revenue 1000, cpl 30   (spend  300 / 10 leads)
  //   t3: revenue 3000, cpl 200  (spend 2000 / 10 leads)
  const richTenants = (): TenantCfg[] => [
    {
      id: 1,
      name: "Alpha",
      current: { spend: 1000, leads: leadsN(10), jobs: jobsRev(5000) },
      previous: {},
    },
    {
      id: 2,
      name: "Beta",
      current: { spend: 300, leads: leadsN(10), jobs: jobsRev(1000) },
      previous: {},
    },
    {
      id: 3,
      name: "Gamma",
      current: { spend: 2000, leads: leadsN(10), jobs: jobsRev(3000) },
      previous: {},
    },
  ];

  it("ranks higher-is-better metrics (revenue) in descending order", async () => {
    seed({ tenants: richTenants() });
    const app = await setupApp("super_admin");
    const { status, json } = await getJson(app, "/admin/leaderboard?metric=revenue");

    expect(status).toBe(200);
    expect(findRank(json, 1).rank).toBe(1); // 5000
    expect(findRank(json, 3).rank).toBe(2); // 3000
    expect(findRank(json, 2).rank).toBe(3); // 1000
  });

  it("ranks cpl ascending while other metrics rank descending", async () => {
    seed({ tenants: richTenants() });
    let app = await setupApp("super_admin");
    const cpl = await getJson(app, "/admin/leaderboard?metric=cpl");

    expect(cpl.status).toBe(200);
    // cpl is lower-is-better → cheapest first.
    expect(findRank(cpl.json, 2).rank).toBe(1); // cpl 30
    expect(findRank(cpl.json, 1).rank).toBe(2); // cpl 100
    expect(findRank(cpl.json, 3).rank).toBe(3); // cpl 200

    // Re-seed and request a higher-is-better metric over the same tenants; the
    // ordering must invert relative to cpl.
    seed({ tenants: richTenants() });
    app = await setupApp("super_admin");
    const rev = await getJson(app, "/admin/leaderboard?metric=revenue");

    expect(rev.status).toBe(200);
    expect(findRank(rev.json, 1).rank).toBe(1); // revenue 5000
    expect(findRank(rev.json, 3).rank).toBe(2); // revenue 3000
    expect(findRank(rev.json, 2).rank).toBe(3); // revenue 1000
  });
});

describe("GET /admin/leaderboard — outlier flagging", () => {
  beforeEach(() => {
    state.reset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  // revenue values [100, 100, 100, 1000]: average 325, stdDev ≈ 389.7.
  // The 1000 deviates by 675 > 1.5*stdDev (≈584.6) → outlier. The 100s deviate
  // by 225 → within band.
  it("flags a high outperformer above 1.5 standard deviations", async () => {
    seed({
      tenants: [
        { id: 1, name: "A", current: { jobs: jobsRev(100) }, previous: {} },
        { id: 2, name: "B", current: { jobs: jobsRev(100) }, previous: {} },
        { id: 3, name: "C", current: { jobs: jobsRev(100) }, previous: {} },
        { id: 4, name: "D", current: { jobs: jobsRev(1000) }, previous: {} },
      ],
    });
    const app = await setupApp("super_admin");
    const { status, json } = await getJson(app, "/admin/leaderboard?metric=revenue");

    expect(status).toBe(200);
    expect(json.agencyAverage).toBe(325);

    const outlier = findRank(json, 4);
    expect(outlier.isOutlier).toBe(true);
    expect(outlier.outlierDirection).toBe("outperforming");

    const normal = findRank(json, 1);
    expect(normal.isOutlier).toBe(false);
    expect(normal.outlierDirection).toBeNull();
  });

  // revenue values [1000, 1000, 1000, 100]: average 775; the 100 deviates by
  // 675 > 1.5*stdDev → outlier, and sits below average → underperforming.
  it("flags a low underperformer below the agency average", async () => {
    seed({
      tenants: [
        { id: 1, name: "A", current: { jobs: jobsRev(1000) }, previous: {} },
        { id: 2, name: "B", current: { jobs: jobsRev(1000) }, previous: {} },
        { id: 3, name: "C", current: { jobs: jobsRev(1000) }, previous: {} },
        { id: 4, name: "D", current: { jobs: jobsRev(100) }, previous: {} },
      ],
    });
    const app = await setupApp("super_admin");
    const { status, json } = await getJson(app, "/admin/leaderboard?metric=revenue");

    expect(status).toBe(200);
    const outlier = findRank(json, 4);
    expect(outlier.isOutlier).toBe(true);
    expect(outlier.outlierDirection).toBe("underperforming");
  });
});

describe("GET /admin/leaderboard — products payload", () => {
  beforeEach(() => {
    state.reset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("maps name, category, pricePaid and purchasedAt from the purchases/items join", async () => {
    seed({
      tenants: [
        {
          id: 1,
          name: "Alpha",
          current: { jobs: jobsRev(5000) },
          previous: {},
          products: [
            {
              itemTitle: "Sales Bootcamp",
              itemCategory: "sales",
              pricePaid: 1200,
              purchasedAt: "2026-05-10T00:00:00.000Z",
            },
            {
              itemTitle: "Ops Masterclass",
              itemCategory: "operations",
              pricePaid: 800,
              purchasedAt: "2026-05-12T00:00:00.000Z",
            },
          ],
        },
      ],
    });
    const app = await setupApp("super_admin");
    const { status, json } = await getJson(app, "/admin/leaderboard?metric=revenue");

    expect(status).toBe(200);
    const alpha = findRank(json, 1);
    expect(alpha.products).toEqual([
      {
        name: "Sales Bootcamp",
        category: "sales",
        pricePaid: 1200,
        purchasedAt: "2026-05-10T00:00:00.000Z",
      },
      {
        name: "Ops Masterclass",
        category: "operations",
        pricePaid: 800,
        purchasedAt: "2026-05-12T00:00:00.000Z",
      },
    ]);
  });

  it("defaults to an empty products list when a tenant has no purchases", async () => {
    seed({
      tenants: [
        { id: 1, name: "Alpha", current: { jobs: jobsRev(5000) }, previous: {} },
      ],
    });
    const app = await setupApp("super_admin");
    const { status, json } = await getJson(app, "/admin/leaderboard?metric=revenue");

    expect(status).toBe(200);
    expect(findRank(json, 1).products).toEqual([]);
  });

  it("scopes each tenant's products to that tenant", async () => {
    seed({
      tenants: [
        {
          id: 1,
          name: "Alpha",
          current: { jobs: jobsRev(5000) },
          previous: {},
          products: [
            {
              itemTitle: "Alpha Course",
              itemCategory: "sales",
              pricePaid: 500,
              purchasedAt: "2026-05-01T00:00:00.000Z",
            },
          ],
        },
        {
          id: 2,
          name: "Beta",
          current: { jobs: jobsRev(3000) },
          previous: {},
          products: [
            {
              itemTitle: "Beta Course",
              itemCategory: "marketing",
              pricePaid: 700,
              purchasedAt: "2026-05-02T00:00:00.000Z",
            },
          ],
        },
      ],
    });
    const app = await setupApp("super_admin");
    const { status, json } = await getJson(app, "/admin/leaderboard?metric=revenue");

    expect(status).toBe(200);
    expect(findRank(json, 1).products).toEqual([
      {
        name: "Alpha Course",
        category: "sales",
        pricePaid: 500,
        purchasedAt: "2026-05-01T00:00:00.000Z",
      },
    ]);
    expect(findRank(json, 2).products).toEqual([
      {
        name: "Beta Course",
        category: "marketing",
        pricePaid: 700,
        purchasedAt: "2026-05-02T00:00:00.000Z",
      },
    ]);

    // The single grouped products select must filter by all active tenant ids
    // via inArray, and the route then buckets rows back to each tenant by the
    // tenantId carried on each row.
    expect(drizzle.inArray).toHaveBeenCalledWith("training_purchases.tenantId", [1, 2]);
  });
});

describe("GET /admin/leaderboard — anonymization", () => {
  beforeEach(() => {
    state.reset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  // revenue: Alpha 3000, Beta (caller) 5000, Gamma 1000.
  // Sorted desc: Beta(idx0), Alpha(idx1), Gamma(idx2). Anonymized labels use
  // the post-sort index: idx1 -> "Client B", idx2 -> "Client C". The caller
  // keeps its real name.
  const threeTenants = (): TenantCfg[] => [
    { id: 1, name: "Alpha", current: { jobs: jobsRev(3000) }, previous: {} },
    { id: 2, name: "Beta", current: { jobs: jobsRev(5000) }, previous: {} },
    { id: 3, name: "Gamma", current: { jobs: jobsRev(1000) }, previous: {} },
  ];

  it("anonymizes other tenants but keeps the caller's own name when not in named mode", async () => {
    seed({
      callerRow: {
        id: 2,
        name: "Beta",
        leaderboardConfig: { visible: true, displayMode: "anonymized" },
      },
      tenants: threeTenants(),
    });
    const app = await setupApp("client_admin", 2);
    const { status, json } = await getJson(app, "/admin/leaderboard?metric=revenue");

    expect(status).toBe(200);
    expect(json.forceAnonymized).toBe(true);

    const caller = findRank(json, 2);
    expect(caller.tenantName).toBe("Beta"); // own tenant keeps real name
    expect(caller.isOwnTenant).toBe(true);

    expect(findRank(json, 1).tenantName).toBe("Client B"); // sort idx 1
    expect(findRank(json, 1).isOwnTenant).toBe(false);
    expect(findRank(json, 3).tenantName).toBe("Client C"); // sort idx 2
  });

  it("keeps real names for a non-agency caller in named mode and flags own tenant", async () => {
    seed({
      callerRow: {
        id: 2,
        name: "Beta",
        leaderboardConfig: { visible: true, displayMode: "named" },
      },
      tenants: threeTenants(),
    });
    const app = await setupApp("client_admin", 2);
    const { status, json } = await getJson(app, "/admin/leaderboard?metric=revenue");

    expect(status).toBe(200);
    expect(json.forceAnonymized).toBe(false);

    expect(findRank(json, 1).tenantName).toBe("Alpha"); // real names retained
    expect(findRank(json, 2).tenantName).toBe("Beta");
    expect(findRank(json, 3).tenantName).toBe("Gamma");

    expect(findRank(json, 2).isOwnTenant).toBe(true); // caller flagged
    expect(findRank(json, 1).isOwnTenant).toBe(false);
  });

  it("does not anonymize for agency callers", async () => {
    seed({ tenants: threeTenants() });
    const app = await setupApp("super_admin");
    const { status, json } = await getJson(app, "/admin/leaderboard?metric=revenue");

    expect(status).toBe(200);
    expect(json.forceAnonymized).toBe(false);
    expect(findRank(json, 1).tenantName).toBe("Alpha");
    expect(findRank(json, 2).isOwnTenant).toBe(false);
  });
});

// The batch helper's own bucketing is unit-tested in admin-tenant-metrics.test.ts.
// These tests close the loop end-to-end through the route: with several tenants
// each holding *distinct, non-zero* current AND previous numbers, every emitted
// leaderboard row must reflect only its own tenant's metrics, previousValue and
// delta — never a neighbour's. The earlier trend/sort suites only ever vary one
// tenant at a time or zero out the previous period, so they cannot catch a
// route-level mis-map of batch output to rows.
describe("GET /admin/leaderboard — per-tenant isolation (no cross-contamination)", () => {
  beforeEach(() => {
    state.reset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  // Three tenants, all with distinct current+previous revenue and distinct
  // spend/lead mixes so cpl differs too. If the route cross-attributed any
  // batch row, at least one of metricValue/previousValue/trend/revenue/cpl
  // below would land on the wrong tenant.
  //   Alpha: rev 5000 (prev 4000, trend +25), spend 1000 / 10 leads → cpl 100
  //   Beta : rev 3000 (prev 1500, trend +100), spend  600 / 20 leads → cpl  30
  //   Gamma: rev 1200 (prev 2400, trend  -50), spend 1200 / 10 leads → cpl 120
  const distinctTenants = (): TenantCfg[] => [
    {
      id: 1,
      name: "Alpha",
      current: { spend: 1000, leads: leadsN(10), jobs: jobsRev(5000) },
      previous: { jobs: jobsRev(4000) },
    },
    {
      id: 2,
      name: "Beta",
      current: { spend: 600, leads: leadsN(20), jobs: jobsRev(3000) },
      previous: { jobs: jobsRev(1500) },
    },
    {
      id: 3,
      name: "Gamma",
      current: { spend: 1200, leads: leadsN(10), jobs: jobsRev(1200) },
      previous: { jobs: jobsRev(2400) },
    },
  ];

  it("attributes each tenant's metric value, previous value and delta to only that tenant", async () => {
    seed({ tenants: distinctTenants() });
    const app = await setupApp("super_admin");
    const { status, json } = await getJson(app, "/admin/leaderboard?metric=revenue");

    expect(status).toBe(200);

    const alpha = findRank(json, 1);
    expect(alpha.metricValue).toBe(5000);
    expect(alpha.previousValue).toBe(4000);
    expect(alpha.trend).toBe(25); // (5000-4000)/4000
    expect(alpha.revenue).toBe(5000);
    expect(alpha.cpl).toBe(100); // 1000 / 10
    expect(alpha.rank).toBe(1);

    const beta = findRank(json, 2);
    expect(beta.metricValue).toBe(3000);
    expect(beta.previousValue).toBe(1500);
    expect(beta.trend).toBe(100); // (3000-1500)/1500
    expect(beta.revenue).toBe(3000);
    expect(beta.cpl).toBe(30); // 600 / 20
    expect(beta.rank).toBe(2);

    const gamma = findRank(json, 3);
    expect(gamma.metricValue).toBe(1200);
    expect(gamma.previousValue).toBe(2400);
    expect(gamma.trend).toBe(-50); // (1200-2400)/2400
    expect(gamma.revenue).toBe(1200);
    expect(gamma.cpl).toBe(120); // 1200 / 10
    expect(gamma.rank).toBe(3);
  });

  it("keeps the selected metric independent per tenant when ranking by cpl", async () => {
    // Same tenants, different metric: cpl is lower-is-better, so the ordering
    // must invert relative to revenue while each row still carries its own
    // cpl current/previous and delta. previous cpl: Alpha 0 (no prev spend/leads),
    // Beta 0, Gamma 0 → trend falls back to 100 (current cpl > 0) for all.
    seed({ tenants: distinctTenants() });
    const app = await setupApp("super_admin");
    const { status, json } = await getJson(app, "/admin/leaderboard?metric=cpl");

    expect(status).toBe(200);

    const beta = findRank(json, 2);
    expect(beta.metricValue).toBe(30); // cheapest cpl
    expect(beta.rank).toBe(1);

    const alpha = findRank(json, 1);
    expect(alpha.metricValue).toBe(100);
    expect(alpha.rank).toBe(2);

    const gamma = findRank(json, 3);
    expect(gamma.metricValue).toBe(120);
    expect(gamma.rank).toBe(3);

    // The secondary fields stay glued to their own tenant regardless of the
    // sort metric: each row's revenue is still its own.
    expect(alpha.revenue).toBe(5000);
    expect(beta.revenue).toBe(3000);
    expect(gamma.revenue).toBe(1200);
  });

  it("keeps metrics bound to the correct tenant even when names are anonymized", async () => {
    // Non-agency caller (Beta) in anonymized mode. Names get masked by post-sort
    // index, but each tenantId's metricValue/previousValue/trend must remain its
    // own — masking the label must never shuffle the numbers.
    //   revenue desc: Alpha 5000 (idx0), Beta 3000 (idx1, caller), Gamma 1200 (idx2)
    //   labels: Alpha "Client A", Beta keeps "Beta", Gamma "Client C"
    seed({
      callerRow: {
        id: 2,
        name: "Beta",
        leaderboardConfig: { visible: true, displayMode: "anonymized" },
      },
      tenants: distinctTenants(),
    });
    const app = await setupApp("client_admin", 2);
    const { status, json } = await getJson(app, "/admin/leaderboard?metric=revenue");

    expect(status).toBe(200);
    expect(json.forceAnonymized).toBe(true);

    const alpha = findRank(json, 1);
    expect(alpha.tenantName).toBe("Client A"); // sort idx 0, not caller
    expect(alpha.isOwnTenant).toBe(false);
    expect(alpha.metricValue).toBe(5000);
    expect(alpha.previousValue).toBe(4000);
    expect(alpha.trend).toBe(25);

    const beta = findRank(json, 2);
    expect(beta.tenantName).toBe("Beta"); // caller keeps real name
    expect(beta.isOwnTenant).toBe(true);
    expect(beta.metricValue).toBe(3000);
    expect(beta.previousValue).toBe(1500);
    expect(beta.trend).toBe(100);

    const gamma = findRank(json, 3);
    expect(gamma.tenantName).toBe("Client C"); // sort idx 2
    expect(gamma.isOwnTenant).toBe(false);
    expect(gamma.metricValue).toBe(1200);
    expect(gamma.previousValue).toBe(2400);
    expect(gamma.trend).toBe(-50);
  });
});

// The leaderboard ranks only tenants where isActive = true (the route filters
// the tenant list with `WHERE isActive = true`). These tests seed a mix of
// active and inactive tenants — the inactive ones carry their own leads/jobs/
// spend rows in the underlying tables — and prove the deactivated clients never
// surface in the rankings, the agency average or the outlier math. The
// `drizzle.eq(tenantsTable.isActive, true)` assertion is the regression guard:
// if a refactor drops the isActive filter, that expectation fails immediately.
describe("GET /admin/leaderboard — active-tenant scoping", () => {
  beforeEach(() => {
    state.reset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("excludes inactive tenants from the rankings and agency average", async () => {
    // Active: Alpha 1000, Beta 3000 → agency average 2000. Inactive Zombie has
    // a far larger 9000 revenue; were the isActive filter dropped it would both
    // appear in the rankings and drag the average up to 4333.
    seed({
      tenants: [
        { id: 1, name: "Alpha", current: { jobs: jobsRev(1000) }, previous: {} },
        { id: 2, name: "Beta", current: { jobs: jobsRev(3000) }, previous: {} },
      ],
      inactiveTenants: [
        { id: 3, name: "Zombie", current: { jobs: jobsRev(9000) }, previous: {} },
      ],
    });
    const app = await setupApp("super_admin");
    const { status, json } = await getJson(app, "/admin/leaderboard?metric=revenue");

    expect(status).toBe(200);

    // The route must scope the tenant list with `WHERE isActive = true`.
    expect(drizzle.eq).toHaveBeenCalledWith("tenants.isActive", true);

    const rankings = json.rankings as Array<Record<string, unknown>>;
    expect(rankings).toHaveLength(2);
    expect(rankings.map((r) => r.tenantId).sort()).toEqual([1, 2]);
    // The inactive tenant never surfaces, regardless of its (larger) revenue.
    expect(rankings.some((r) => r.tenantId === 3)).toBe(false);

    // Agency average is computed over active tenants only: (1000 + 3000) / 2.
    expect(json.agencyAverage).toBe(2000);
  });

  it("computes outlier stats over active tenants only", async () => {
    // Active revenue [100, 100, 100, 1000]: average 325, and D (1000) is an
    // outlier above 1.5 standard deviations (mirrors the outlier-flagging
    // suite). The inactive Zombie carries an extreme 100000 revenue; if it
    // leaked into the population the average and standard deviation would shift
    // dramatically and D would no longer flag.
    seed({
      tenants: [
        { id: 1, name: "A", current: { jobs: jobsRev(100) }, previous: {} },
        { id: 2, name: "B", current: { jobs: jobsRev(100) }, previous: {} },
        { id: 3, name: "C", current: { jobs: jobsRev(100) }, previous: {} },
        { id: 4, name: "D", current: { jobs: jobsRev(1000) }, previous: {} },
      ],
      inactiveTenants: [
        { id: 5, name: "Zombie", current: { jobs: jobsRev(100000) }, previous: {} },
      ],
    });
    const app = await setupApp("super_admin");
    const { status, json } = await getJson(app, "/admin/leaderboard?metric=revenue");

    expect(status).toBe(200);

    const rankings = json.rankings as Array<Record<string, unknown>>;
    expect(rankings.some((r) => r.tenantId === 5)).toBe(false);

    // Average and outlier math reflect the four active tenants only.
    expect(json.agencyAverage).toBe(325);

    const outlier = findRank(json, 4);
    expect(outlier.isOutlier).toBe(true);
    expect(outlier.outlierDirection).toBe("outperforming");

    const normal = findRank(json, 1);
    expect(normal.isOutlier).toBe(false);
    expect(normal.outlierDirection).toBeNull();
  });
});
