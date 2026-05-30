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
}: {
  tenants: TenantCfg[];
  callerRow?: Record<string, unknown>;
}) {
  const byTable: Record<string, unknown[][]> = {
    tenants: [],
    campaign_daily_stats: [],
    leads: [],
    jobs: [],
    training_purchases: [],
  };
  if (callerRow) byTable.tenants.push([callerRow]);
  byTable.tenants.push(tenants.map((t) => ({ id: t.id, name: t.name })));

  // Emit one grouped result per period (current first, then previous), each a
  // row-set spanning every tenant — matching the two batched passes the route
  // runs via Promise.all([batch(current), batch(previous)]).
  for (const period of ["current", "previous"] as const) {
    const leadRows: Array<{ tenantId: number; totalLeads: number; bookedLeads: number; soldLeads: number }> = [];
    const jobRows: Array<{ tenantId: number; revenue: number }> = [];
    const spendRows: Array<{ tenantId: number; total: number }> = [];
    for (const t of tenants) {
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
