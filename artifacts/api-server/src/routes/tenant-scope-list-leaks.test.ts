// Role-matrix coverage for the list-endpoint tenant-scope contract
// established by GET /attribution/events (tasks #382 / #388).
//
// For every list endpoint that previously trusted only an optional
// `query.tenantId`, verify:
//   1. tenant-scoped role + no session.tenantId → 403, no DB read
//   2. tenant-scoped role + session.tenantId = X + query.tenantId = Y →
//      scope is forced to X (the attacker-supplied Y is ignored)
//
// These tests exercise each fixed route module end-to-end through
// express; the heavy lifting of "what tenant scope did the handler
// pick" is observed via spies on drizzle's `eq` and on `db.select` so
// we don't need a real database.
//
// The helper itself has its own unit tests in
// `src/lib/tenant-scope.test.ts` — these tests are about ensuring each
// route is wired through the helper *before* any DB access.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NO_TENANT_ASSIGNED_ERROR, TENANT_REQUIRED_ERROR } from "../lib/tenant-scope";

const mockDb = {
  selectResults: [] as unknown[][],
  _selectIdx: 0,
  reset() {
    this._selectIdx = 0;
    this.selectResults = [];
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

// A permissive chain that resolves to whatever the next selectResults
// slot holds. Supports any combination of .from / .where / .orderBy /
// .limit / .offset / .innerJoin / .leftJoin / .groupBy that the routes
// under test happen to call.
function makeSelectChain(results: () => unknown[]) {
  const chain: Record<string, unknown> = {};
  const thenResult = () => makeThenable(results());
  const passthrough = () => chain;
  chain.from = vi.fn().mockImplementation(passthrough);
  chain.innerJoin = vi.fn().mockImplementation(passthrough);
  chain.leftJoin = vi.fn().mockImplementation(passthrough);
  chain.groupBy = vi.fn().mockImplementation(passthrough);
  chain.orderBy = vi.fn().mockImplementation(passthrough);
  chain.where = vi.fn().mockImplementation(passthrough);
  chain.limit = vi.fn().mockImplementation(() => Promise.resolve(results()));
  chain.offset = vi.fn().mockImplementation(() => Promise.resolve(results()));
  chain.then = (resolve: Function, reject?: Function) =>
    Promise.resolve(results()).then(resolve as (v: unknown) => unknown, reject as (e: unknown) => unknown);
  // Some routes treat .where(...) as the terminal step (await directly).
  // Re-wire .where to also be thenable while still chaining on demand.
  chain.where = vi.fn().mockImplementation(() => {
    return Object.assign(thenResult(), {
      orderBy: vi.fn().mockReturnValue(
        Object.assign(thenResult(), {
          limit: vi.fn().mockImplementation(() => Object.assign(thenResult(), {
            offset: vi.fn().mockImplementation(() => Promise.resolve(results())),
          })),
          offset: vi.fn().mockImplementation(() => Promise.resolve(results())),
        }),
      ),
      limit: vi.fn().mockImplementation(() => Object.assign(thenResult(), {
        offset: vi.fn().mockImplementation(() => Promise.resolve(results())),
      })),
      groupBy: vi.fn().mockReturnValue(thenResult()),
    });
  });
  return chain;
}

vi.mock("@workspace/db", () => {
  const tablecol = (t: string) => new Proxy({}, {
    get: (_, k) => `${t}.${String(k)}`,
  });
  return {
    db: {
      select: vi.fn().mockImplementation(() => {
        const idx = mockDb._selectIdx++;
        return makeSelectChain(() => mockDb.selectResults[idx] || []);
      }),
      selectDistinct: vi.fn().mockImplementation(() => {
        const idx = mockDb._selectIdx++;
        return makeSelectChain(() => mockDb.selectResults[idx] || []);
      }),
    },
    leadsTable: tablecol("leads"),
    jobsTable: tablecol("jobs"),
    campaignsTable: tablecol("campaigns"),
    campaignDailyStatsTable: tablecol("campaign_daily_stats"),
    metaAdAccountsTable: tablecol("meta_ad_accounts"),
    metaAdSetsTable: tablecol("meta_ad_sets"),
    metaAdsTable: tablecol("meta_ads"),
    metaAdDailyStatsTable: tablecol("meta_ad_daily_stats"),
    changeLogsTable: tablecol("change_logs"),
    funnelTypesTable: tablecol("funnel_types"),
    tenantFunnelTypesTable: tablecol("tenant_funnel_types"),
    tenantsTable: tablecol("tenants"),
    callAttemptsTable: tablecol("call_attempts"),
    podiumMessagesTable: tablecol("podium_messages"),
    leadMergesTable: tablecol("lead_merges"),
    attributionEventsTable: tablecol("attribution_events"),
    reconciliationRunsTable: Symbol("reconciliationRunsTable"),
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
  count: vi.fn((...a: unknown[]) => asAble({ __op: "count", a })),
  desc: vi.fn((...a: unknown[]) => asAble({ __op: "desc", a })),
  sum: vi.fn((...a: unknown[]) => asAble({ __op: "sum", a })),
  sql: Object.assign(
    vi.fn((..._a: unknown[]) => asAble({ __op: "sql" })),
    { join: vi.fn((...a: unknown[]) => asAble({ __op: "sql.join", a })) },
  ),
  inArray: vi.fn((...a: unknown[]) => asAble({ __op: "inArray", a })),
  gte: vi.fn((...a: unknown[]) => asAble({ __op: "gte", a })),
  lte: vi.fn((...a: unknown[]) => asAble({ __op: "lte", a })),
}));

vi.mock("@workspace/api-zod", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return actual;
});

vi.mock("../socket", () => ({
  emitNewLead: vi.fn(),
  emitNewAttributionEvent: vi.fn(),
  emitLeadUpdated: vi.fn(),
  getHudStats: vi.fn().mockResolvedValue({}),
}));

vi.mock("../services/integrations/communication", () => ({
  initiateCall: vi.fn(),
  initiateText: vi.fn(),
  getTenantCommConfig: vi.fn(),
  getCommConfigStatus: vi.fn(),
}));

vi.mock("../services/lead-scoring", () => ({
  getSmartQueue: vi.fn().mockResolvedValue({ leads: [], total: 0 }),
}));

vi.mock("../services/coordinator-stats", () => ({
  getComparisonStats: vi.fn().mockResolvedValue({}),
  getHistoricalStats: vi.fn().mockResolvedValue({}),
  aggregateDailyStats: vi.fn().mockResolvedValue(0),
}));

vi.mock("../services/parse-filter", () => ({
  parseFilterQuery: vi.fn(),
}));

const mockReconciliationStatus = vi.fn();
vi.mock("../services/reconciliation", () => ({
  runReconciliation: vi.fn(),
  getReconciliationStatus: (...args: unknown[]) => mockReconciliationStatus(...args),
}));

vi.mock("../middleware/auth", async () => {
  const actual = (await vi.importActual("../middleware/auth")) as Record<string, unknown>;
  return actual;
});

import express, { type Request, type Response, type NextFunction } from "express";

async function setupApp(routerPath: string, role: string, tenantId: number | null) {
  vi.resetModules();
  const mod = await import(routerPath);
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
  expressApp: express.Express,
  path: string,
): Promise<{ status: number; json: Record<string, unknown> | unknown[] }> {
  return new Promise((resolve) => {
    const http = require("http");
    const server = http.createServer(expressApp);
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

async function tenantEqArgsFor(table: string): Promise<unknown[]> {
  const drizzle = await import("drizzle-orm");
  return vi
    .mocked(drizzle.eq)
    .mock.calls.filter((c) => (c[0] as unknown as string) === `${table}.tenantId`)
    .map((c) => c[1]);
}

interface RouteCase {
  name: string;
  routerPath: string;
  url: string;
  // The drizzle table whose tenantId column is expected to be scoped
  // when the handler runs. `null` means the handler doesn't push an
  // `eq(table.tenantId, ...)` directly but still must 403 for the
  // missing-session-tenant case (e.g. handlers that delegate to a
  // service like getSmartQueue and fail closed at the helper).
  tenantTable: string | null;
  // Pre-seeded results for the success-case run (with session
  // tenantId=7 and query.tenantId=9). Routes that do many sequential
  // selects need enough slots to satisfy them all; we pad with `[]`
  // up to 8 slots which is enough for the routes under test.
  successSelectResults?: unknown[][];
}

const cases: RouteCase[] = [
  { name: "GET /jobs", routerPath: "./jobs", url: "/jobs", tenantTable: "jobs",
    successSelectResults: [[], [{ count: 0 }]] },
  { name: "GET /change-logs", routerPath: "./change-logs", url: "/change-logs", tenantTable: "change_logs",
    successSelectResults: [[]] },
  { name: "GET /drilldown/leads", routerPath: "./drilldown", url: "/drilldown/leads", tenantTable: "leads",
    successSelectResults: [[]] },
  { name: "GET /drilldown/jobs", routerPath: "./drilldown", url: "/drilldown/jobs", tenantTable: "jobs",
    successSelectResults: [[]] },
  { name: "GET /campaigns", routerPath: "./campaigns", url: "/campaigns", tenantTable: "campaigns",
    successSelectResults: [[]] },
  { name: "GET /campaigns/stats", routerPath: "./campaigns", url: "/campaigns/stats", tenantTable: "campaigns",
    successSelectResults: [[{ id: 1 }], []] },
  { name: "GET /campaigns/meta-summary", routerPath: "./campaigns", url: "/campaigns/meta-summary", tenantTable: "campaigns",
    successSelectResults: [[]] },
  { name: "GET /funnel-types", routerPath: "./funnel-types", url: "/funnel-types", tenantTable: "tenant_funnel_types",
    successSelectResults: [[{ funnelTypeId: 1 }], [{ id: 1, name: "x" }]] },
  { name: "GET /leads", routerPath: "./leads", url: "/leads", tenantTable: "leads",
    successSelectResults: [[], [{ count: 0 }]] },
  { name: "GET /leads/search", routerPath: "./leads", url: "/leads/search?q=test", tenantTable: "leads",
    successSelectResults: [[], [{ count: 0 }]] },
  { name: "GET /leads/hud/queue (no DB scope, helper-only)", routerPath: "./leads", url: "/leads/hud/queue", tenantTable: null },
  { name: "GET /leads/hud/stats (no DB scope, helper-only)", routerPath: "./leads", url: "/leads/hud/stats", tenantTable: null },
  { name: "GET /leads/hud/comparison (no DB scope, helper-only)", routerPath: "./leads", url: "/leads/hud/comparison", tenantTable: null },
  { name: "GET /leads/hud/historical (no DB scope, helper-only)", routerPath: "./leads", url: "/leads/hud/historical", tenantTable: null },
];

describe("List-endpoint tenant scoping (cross-tenant leak prevention)", () => {
  beforeEach(() => {
    mockDb.reset();
    vi.clearAllMocks();
  });

  for (const c of cases) {
    describe(c.name, () => {
      it("returns 403 'No tenant assigned' for tenant-scoped role with no session.tenantId, and never reads the DB", async () => {
        const app = await setupApp(c.routerPath, "tenant_user", null);

        const res = await getJson(app, c.url);

        expect(res.status).toBe(403);
        expect(res.json).toEqual(NO_TENANT_ASSIGNED_ERROR);

        // Critical: the handler must short-circuit BEFORE any DB read.
        // If it doesn't, even a transient unscoped query is enough to
        // leak rows into logs, error messages, etc.
        const dbMod = await import("@workspace/db");
        expect(vi.mocked(dbMod.db.select)).not.toHaveBeenCalled();
      });

      it("forces session tenantId for tenant-scoped role, ignoring an attacker-supplied query.tenantId", async () => {
        const app = await setupApp(c.routerPath, "tenant_user", 7);
        mockDb.selectResults = c.successSelectResults ?? [];

        const sep = c.url.includes("?") ? "&" : "?";
        const res = await getJson(app, `${c.url}${sep}tenantId=9`);

        // We don't assert response shape here — different routes have
        // different shapes. We only assert the security contract:
        // every drizzle eq() against the tenantId column used 7
        // (session), never 9 (attacker-supplied).
        expect(res.status).toBeLessThan(500);

        if (c.tenantTable) {
          const tenantArgs = await tenantEqArgsFor(c.tenantTable);
          expect(tenantArgs).toContain(7);
          expect(tenantArgs).not.toContain(9);
          expect(tenantArgs).not.toContain("9");
        }
      });
    });
  }

  // Heavy list/drilldown endpoints opted into `{ requireTenant: true }`
  // (task #749). After the global keyset indexes were dropped, an
  // unfiltered cross-tenant request (super_admin / agency_user with no
  // tenantId) would run an unindexed full-table ORDER BY — so the helper
  // must 400 BEFORE any DB read instead of serving the unscoped query.
  describe("requireTenant — reject unfiltered cross-tenant list requests", () => {
    const requireTenantCases = [
      { name: "GET /leads", routerPath: "./leads", url: "/leads" },
      { name: "GET /jobs", routerPath: "./jobs", url: "/jobs" },
      { name: "GET /attribution/events", routerPath: "./attribution", url: "/attribution/events" },
      { name: "GET /drilldown/leads", routerPath: "./drilldown", url: "/drilldown/leads" },
      { name: "GET /drilldown/jobs", routerPath: "./drilldown", url: "/drilldown/jobs" },
      // Revenue Attributed list/summary/facets (task #750): each runs a heavy
      // jobs→leads→funnel_types join over completed jobs, so an unfiltered
      // cross-tenant request must be rejected before any DB read. The facets
      // route uses db.selectDistinct (not db.select), hence the dual assertion.
      { name: "GET /drilldown/revenue-attributed", routerPath: "./drilldown", url: "/drilldown/revenue-attributed" },
      { name: "GET /drilldown/revenue-attributed/summary", routerPath: "./drilldown", url: "/drilldown/revenue-attributed/summary" },
      { name: "GET /drilldown/revenue-attributed/facets", routerPath: "./drilldown", url: "/drilldown/revenue-attributed/facets" },
    ];

    for (const role of ["super_admin", "agency_user"] as const) {
      for (const c of requireTenantCases) {
        it(`${c.name}: ${role} with no tenantId → 400, and never reads the DB`, async () => {
          const app = await setupApp(c.routerPath, role, null);

          const res = await getJson(app, c.url);

          expect(res.status).toBe(400);
          expect(res.json).toEqual(TENANT_REQUIRED_ERROR);

          const dbMod = await import("@workspace/db");
          expect(vi.mocked(dbMod.db.select)).not.toHaveBeenCalled();
          expect(vi.mocked(dbMod.db.selectDistinct)).not.toHaveBeenCalled();
        });
      }
    }

    // The drilldown routes parse tenantId manually with Number(...), so an
    // invalid `tenantId=abc` produces NaN. The helper must normalize that
    // to "no tenant" and 400 — otherwise NaN slips past the requireTenant
    // check and the truthy `if (scope.tenantId)` filter drops it, yielding
    // the exact unscoped full-table query this task closes off. (The other
    // requireTenant routes parse tenantId via a zod.coerce.number() schema,
    // which already rejects a non-numeric value before the handler runs, so
    // they don't share this manual-parse gap.)
    const manualParseCases = [
      { name: "GET /drilldown/leads", routerPath: "./drilldown", url: "/drilldown/leads" },
      { name: "GET /drilldown/jobs", routerPath: "./drilldown", url: "/drilldown/jobs" },
      // Revenue Attributed routes also parse tenantId with Number(...), so they
      // share the same NaN gap and must coerce it to "no tenant" → 400.
      { name: "GET /drilldown/revenue-attributed", routerPath: "./drilldown", url: "/drilldown/revenue-attributed" },
      { name: "GET /drilldown/revenue-attributed/summary", routerPath: "./drilldown", url: "/drilldown/revenue-attributed/summary" },
      { name: "GET /drilldown/revenue-attributed/facets", routerPath: "./drilldown", url: "/drilldown/revenue-attributed/facets" },
    ];
    for (const role of ["super_admin", "agency_user"] as const) {
      for (const c of manualParseCases) {
        it(`${c.name}: ${role} with invalid tenantId=abc → 400, and never reads the DB`, async () => {
          const app = await setupApp(c.routerPath, role, null);

          const sep = c.url.includes("?") ? "&" : "?";
          const res = await getJson(app, `${c.url}${sep}tenantId=abc`);

          expect(res.status).toBe(400);
          expect(res.json).toEqual(TENANT_REQUIRED_ERROR);

          const dbMod = await import("@workspace/db");
          expect(vi.mocked(dbMod.db.select)).not.toHaveBeenCalled();
          expect(vi.mocked(dbMod.db.selectDistinct)).not.toHaveBeenCalled();
        });
      }
    }
  });

  // The Pulse HUD endpoints are per-tenant views with no cross-tenant mode, so
  // task #750 opts them into `{ requireTenant: true }`. They delegate to mocked
  // services (getSmartQueue / getHudStats / getComparisonStats /
  // getHistoricalStats) rather than db.select directly, so we assert the
  // service is never reached when a super_admin / agency_user omits or
  // malforms the tenantId (the manual `Number(...)` parse turns `abc` into NaN,
  // which the helper must coerce to "no tenant" → 400).
  describe("requireTenant — reject unfiltered cross-tenant HUD requests", () => {
    const hudCases = [
      { name: "GET /leads/hud/queue", url: "/leads/hud/queue", servicePath: "../services/lead-scoring", fn: "getSmartQueue" },
      { name: "GET /leads/hud/stats", url: "/leads/hud/stats", servicePath: "../socket", fn: "getHudStats" },
      { name: "GET /leads/hud/comparison", url: "/leads/hud/comparison", servicePath: "../services/coordinator-stats", fn: "getComparisonStats" },
      { name: "GET /leads/hud/historical", url: "/leads/hud/historical", servicePath: "../services/coordinator-stats", fn: "getHistoricalStats" },
    ];
    for (const role of ["super_admin", "agency_user"] as const) {
      for (const c of hudCases) {
        for (const variant of [
          { label: "no tenantId", query: "" },
          { label: "invalid tenantId=abc", query: "?tenantId=abc" },
        ]) {
          it(`${c.name}: ${role} with ${variant.label} → 400, and never invokes the service`, async () => {
            const app = await setupApp("./leads", role, null);

            const res = await getJson(app, `${c.url}${variant.query}`);

            expect(res.status).toBe(400);
            expect(res.json).toEqual(TENANT_REQUIRED_ERROR);

            const svc = (await import(c.servicePath)) as Record<string, unknown>;
            expect(vi.mocked(svc[c.fn] as (...args: unknown[]) => unknown)).not.toHaveBeenCalled();
          });
        }
      }
    }
  });

  // /leads/search is deliberately NOT opted into requireTenant (task #750): it
  // resolves to a single concrete tenant and short-circuits to an empty result
  // when none is available, so an unfiltered admin request can never run a
  // full-table scan. Lock in that it returns 200 with an empty list — never the
  // 400 the guarded endpoints return — so a future refactor doesn't silently
  // break the intentional session-tenant fallback.
  describe("/leads/search — intentionally allows the no-tenant path", () => {
    for (const role of ["super_admin", "agency_user"] as const) {
      it(`${role} with no tenantId and no session tenant → 200 empty list (not 400)`, async () => {
        const app = await setupApp("./leads", role, null);

        const res = await getJson(app, "/leads/search?q=test");

        expect(res.status).toBe(200);
        expect(res.json).toEqual({ leads: [], total: 0 });
      });
    }
  });

  describe("GET /dashboard/spend-revenue", () => {
    it("returns 403 'No tenant assigned' for tenant-scoped role with no session.tenantId, and never reads the DB", async () => {
      const app = await setupApp("./dashboard", "tenant_user", null);
      const res = await getJson(app, "/dashboard/spend-revenue");
      expect(res.status).toBe(403);
      expect(res.json).toEqual(NO_TENANT_ASSIGNED_ERROR);
      const dbMod = await import("@workspace/db");
      expect(vi.mocked(dbMod.db.select)).not.toHaveBeenCalled();
    });

    it("forces session tenantId for tenant-scoped role, ignoring query.tenantId", async () => {
      const app = await setupApp("./dashboard", "tenant_user", 7);
      mockDb.selectResults = [[], [], [{ total: 0, jobCount: 0 }]];
      const res = await getJson(app, "/dashboard/spend-revenue?tenantId=9");
      expect(res.status).toBeLessThan(500);
      const campaignTenantArgs = await tenantEqArgsFor("campaigns");
      const jobTenantArgs = await tenantEqArgsFor("jobs");
      for (const args of [campaignTenantArgs, jobTenantArgs]) {
        if (args.length > 0) {
          expect(args).toContain(7);
          expect(args).not.toContain(9);
          expect(args).not.toContain("9");
        }
      }
    });
  });

  describe("GET /attribution/reconciliation-status", () => {
    it("returns 403 'No tenant assigned' for tenant-scoped role with no session.tenantId, and never invokes the service", async () => {
      mockReconciliationStatus.mockResolvedValue({});
      const app = await setupApp("./attribution", "tenant_user", null);
      const res = await getJson(app, "/attribution/reconciliation-status");
      expect(res.status).toBe(403);
      expect(res.json).toEqual(NO_TENANT_ASSIGNED_ERROR);
      expect(mockReconciliationStatus).not.toHaveBeenCalled();
    });

    it("forces session tenantId for tenant-scoped role, ignoring query.tenantId", async () => {
      mockReconciliationStatus.mockResolvedValue({ ok: true });
      const app = await setupApp("./attribution", "tenant_user", 7);
      const res = await getJson(app, "/attribution/reconciliation-status?tenantId=9");
      expect(res.status).toBeLessThan(500);
      // Critical: the service receives the session tenantId (7),
      // never the attacker-supplied 9.
      expect(mockReconciliationStatus).toHaveBeenCalledWith(7);
      expect(mockReconciliationStatus).not.toHaveBeenCalledWith(9);
    });
  });

  describe("GET /dashboard/overview", () => {
    // dashboard.ts mounts denyClientUser as a path-level middleware at
    // import time — set up the app the same way the others do.
    it("returns 403 'No tenant assigned' for tenant-scoped role with no session.tenantId, and never reads the DB", async () => {
      const app = await setupApp("./dashboard", "tenant_user", null);
      const res = await getJson(app, "/dashboard/overview");
      expect(res.status).toBe(403);
      expect(res.json).toEqual(NO_TENANT_ASSIGNED_ERROR);
      const dbMod = await import("@workspace/db");
      expect(vi.mocked(dbMod.db.select)).not.toHaveBeenCalled();
    });

    it("forces session tenantId for tenant-scoped role, ignoring query.tenantId", async () => {
      const app = await setupApp("./dashboard", "tenant_user", 7);
      // computeMetrics fires 4 selects; pad enough slots.
      mockDb.selectResults = [
        [{ totalLeads: 0, bookedLeads: 0, soldLeads: 0 }],
        [{ totalJobs: 0, totalRevenue: 0, paidRevenue: 0, invoicedJobCount: 0, matchedEvents: 0 }],
        [],
        [{ bookedWithInvoice: 0 }],
      ];

      const res = await getJson(app, "/dashboard/overview?tenantId=9");

      expect(res.status).toBeLessThan(500);
      const leadTenantArgs = await tenantEqArgsFor("leads");
      const jobTenantArgs = await tenantEqArgsFor("jobs");
      const campaignTenantArgs = await tenantEqArgsFor("campaigns");
      // Every per-table tenant scope used the session tenantId (7) —
      // never the attacker-supplied 9.
      for (const args of [leadTenantArgs, jobTenantArgs, campaignTenantArgs]) {
        if (args.length > 0) {
          expect(args).toContain(7);
          expect(args).not.toContain(9);
          expect(args).not.toContain("9");
        }
      }
    });
  });
});
