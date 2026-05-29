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

vi.mock("drizzle-orm", () => ({
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
      { id: 1, name: "Alpha" },
      { id: 2, name: "Beta" },
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

    const beta = tenants.find((t) => t.tenantId === 2)!;
    expect(beta.totalLeads).toBe(0);
    expect(beta.mtdSpend).toBe(0);
    expect(beta.roas).toBe(0);

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
