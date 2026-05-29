import { describe, it, expect, vi, beforeEach } from "vitest";
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

vi.mock("drizzle-orm", () => {
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
