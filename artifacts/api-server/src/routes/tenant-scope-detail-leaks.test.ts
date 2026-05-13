// Role-matrix coverage for the detail/write-endpoint tenant-scope
// contract established by `assertResourceTenantAccess` (task #393).
//
// For every detail (`GET /:id`) and write (`PATCH/PUT/DELETE /:id`)
// endpoint that previously trusted only `:id` from the path, verify:
//   1. tenant-scoped role + no session.tenantId → 403, no resource access
//   2. tenant-scoped role + session.tenantId = X requesting a resource
//      owned by tenant Y → access denied (403 or 404), no leak of the
//      resource body
//   3. tenant-scoped role + session.tenantId = X requesting its own
//      resource (tenant X) → 200 / 410 (allowed)
//   4. super_admin requesting a resource owned by any tenant → allowed
//
// The helper itself has its own unit tests in
// `src/lib/tenant-scope.test.ts` — these tests are about ensuring each
// route is wired through the helper *before* leaking resource data.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDb = {
  selectResults: [] as unknown[][],
  updateResults: [] as unknown[][],
  _selectIdx: 0,
  _updateIdx: 0,
  reset() {
    this._selectIdx = 0;
    this._updateIdx = 0;
    this.selectResults = [];
    this.updateResults = [];
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

function makeSelectChain(results: () => unknown[]) {
  const chain: Record<string, unknown> = {};
  const passthrough = () => chain;
  chain.from = vi.fn().mockImplementation(passthrough);
  chain.innerJoin = vi.fn().mockImplementation(passthrough);
  chain.leftJoin = vi.fn().mockImplementation(passthrough);
  chain.groupBy = vi.fn().mockImplementation(passthrough);
  chain.orderBy = vi.fn().mockImplementation(passthrough);
  chain.limit = vi.fn().mockImplementation(() => Promise.resolve(results()));
  chain.offset = vi.fn().mockImplementation(() => Promise.resolve(results()));
  chain.then = (resolve: Function, reject?: Function) =>
    Promise.resolve(results()).then(resolve as (v: unknown) => unknown, reject as (e: unknown) => unknown);
  chain.where = vi.fn().mockImplementation(() => {
    const thenResult = () => makeThenable(results());
    return Object.assign(thenResult(), {
      orderBy: vi.fn().mockReturnValue(
        Object.assign(thenResult(), {
          limit: vi.fn().mockImplementation(() => Promise.resolve(results())),
        }),
      ),
      limit: vi.fn().mockImplementation(() => Promise.resolve(results())),
      groupBy: vi.fn().mockReturnValue(thenResult()),
    });
  });
  return chain;
}

function makeUpdateChain(results: () => unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.set = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockReturnValue(chain);
  chain.returning = vi.fn().mockImplementation(() => Promise.resolve(results()));
  return chain;
}

vi.mock("@workspace/db", () => {
  const tablecol = (t: string) => new Proxy({}, { get: (_, k) => `${t}.${String(k)}` });
  return {
    db: {
      select: vi.fn().mockImplementation(() => {
        const idx = mockDb._selectIdx++;
        return makeSelectChain(() => mockDb.selectResults[idx] || []);
      }),
      update: vi.fn().mockImplementation(() => {
        const idx = mockDb._updateIdx++;
        return makeUpdateChain(() => mockDb.updateResults[idx] || []);
      }),
    },
    tenantsTable: tablecol("tenants"),
    usersTable: tablecol("users"),
    leadSourceAliasesTable: tablecol("lead_source_aliases"),
    callrailWebhookStatusTable: tablecol("callrail_webhook_status"),
    leadsTable: tablecol("leads"),
    leadMergesTable: tablecol("lead_merges"),
    callAttemptsTable: tablecol("call_attempts"),
    podiumMessagesTable: tablecol("podium_messages"),
    funnelTypesTable: tablecol("funnel_types"),
    tenantFunnelTypesTable: tablecol("tenant_funnel_types"),
    campaignsTable: tablecol("campaigns"),
    campaignDailyStatsTable: tablecol("campaign_daily_stats"),
    metaAdAccountsTable: tablecol("meta_ad_accounts"),
    metaAdSetsTable: tablecol("meta_ad_sets"),
    metaAdsTable: tablecol("meta_ads"),
    metaAdDailyStatsTable: tablecol("meta_ad_daily_stats"),
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

vi.mock("../services/source-normalizer", () => ({
  DEFAULT_SOURCE_ALIASES: {},
}));

vi.mock("../lib/encryption", () => ({
  encryptConfig: vi.fn((v: unknown) => JSON.stringify(v)),
  decryptConfig: vi.fn(() => ({})),
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

function request(
  expressApp: express.Express,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> | unknown[] }> {
  return new Promise((resolve, reject) => {
    const http = require("http");
    const server = http.createServer(expressApp);
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      const payload = body !== undefined ? JSON.stringify(body) : undefined;
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path,
          method,
          headers: payload
            ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload).toString() }
            : {},
        },
        (res: { statusCode: number; on: Function }) => {
          let data = "";
          res.on("data", (chunk: string) => (data += chunk));
          res.on("end", () => {
            server.close();
            resolve({ status: res.statusCode, json: data ? JSON.parse(data) : {} });
          });
        },
      );
      req.on("error", (err: unknown) => {
        server.close();
        reject(err);
      });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

describe("Detail/write-endpoint tenant scoping (cross-tenant leak prevention)", () => {
  beforeEach(() => {
    mockDb.reset();
    vi.clearAllMocks();
  });

  // GET /tenants/:tenantId — the actual vulnerability fixed by this task.
  // Before the fix, any client_admin / tenant_user / client_user could
  // read another tenant's metadata by passing the foreign id in the path.
  describe("GET /tenants/:tenantId", () => {
    it("tenant-scoped role with no session.tenantId → 403, no DB read", async () => {
      const app = await setupApp("./tenants", "tenant_user", null);
      const res = await request(app, "GET", "/tenants/9");
      expect(res.status).toBe(403);
      expect(res.json).toEqual({ error: "No tenant assigned" });
      const dbMod = await import("@workspace/db");
      expect(vi.mocked(dbMod.db.select)).not.toHaveBeenCalled();
    });

    it("tenant-scoped role requesting a foreign tenant → 403, no DB read, no leak", async () => {
      const app = await setupApp("./tenants", "client_admin", 7);
      // Pre-seed a "rich" tenant row to guarantee no body data leaks.
      mockDb.selectResults = [[{ id: 9, name: "Other Tenant Inc", apiConfig: "secret" }]];
      const res = await request(app, "GET", "/tenants/9");
      expect(res.status).toBe(403);
      expect(res.json).toEqual({ error: "Access denied" });
      const dbMod = await import("@workspace/db");
      expect(vi.mocked(dbMod.db.select)).not.toHaveBeenCalled();
      // Specifically: the tenant name must not have leaked to the caller.
      expect(JSON.stringify(res.json)).not.toContain("Other Tenant Inc");
    });

    it("tenant-scoped role requesting its own tenant → allowed", async () => {
      const app = await setupApp("./tenants", "client_admin", 7);
      mockDb.selectResults = [[{ id: 7, name: "My Tenant", apiConfig: null, communicationConfig: {}, leaderboardConfig: {} }]];
      const res = await request(app, "GET", "/tenants/7");
      expect(res.status).toBe(200);
      expect((res.json as { id: number }).id).toBe(7);
    });

    it("super_admin requesting any tenant → allowed", async () => {
      const app = await setupApp("./tenants", "super_admin", null);
      mockDb.selectResults = [[{ id: 9, name: "Other Tenant", apiConfig: null, communicationConfig: {}, leaderboardConfig: {} }]];
      const res = await request(app, "GET", "/tenants/9");
      expect(res.status).toBe(200);
      expect((res.json as { id: number }).id).toBe(9);
    });

    it("agency_user requesting any tenant → allowed", async () => {
      const app = await setupApp("./tenants", "agency_user", 1);
      mockDb.selectResults = [[{ id: 9, name: "Other Tenant", apiConfig: null, communicationConfig: {}, leaderboardConfig: {} }]];
      const res = await request(app, "GET", "/tenants/9");
      expect(res.status).toBe(200);
      expect((res.json as { id: number }).id).toBe(9);
    });
  });

  describe("PATCH /tenants/:tenantId", () => {
    it("client_admin patching a foreign tenant → 403, no DB write", async () => {
      const app = await setupApp("./tenants", "client_admin", 7);
      const res = await request(app, "PATCH", "/tenants/9", { name: "Hijack" });
      expect(res.status).toBe(403);
      expect(res.json).toEqual({ error: "Cannot modify another tenant" });
      const dbMod = await import("@workspace/db");
      expect(vi.mocked(dbMod.db.update)).not.toHaveBeenCalled();
    });

    it("tenant_user patching any tenant → 403 'Forbidden'", async () => {
      const app = await setupApp("./tenants", "tenant_user", 7);
      const res = await request(app, "PATCH", "/tenants/7", { name: "Try" });
      expect(res.status).toBe(403);
      expect(res.json).toEqual({ error: "Forbidden" });
      const dbMod = await import("@workspace/db");
      expect(vi.mocked(dbMod.db.update)).not.toHaveBeenCalled();
    });
  });

  describe("GET /tenants/:tenantId/callrail-status", () => {
    it("tenant-scoped role requesting a foreign tenant → 403, no DB read", async () => {
      const app = await setupApp("./tenants", "client_admin", 7);
      const res = await request(app, "GET", "/tenants/9/callrail-status");
      expect(res.status).toBe(403);
      expect(res.json).toEqual({ error: "Forbidden" });
      const dbMod = await import("@workspace/db");
      expect(vi.mocked(dbMod.db.select)).not.toHaveBeenCalled();
    });
  });

  // GET /leads/:leadId — pre-existing protection, now using the helper.
  // Confirm the helper-based wiring still rejects cross-tenant access
  // and never leaks the lead row.
  describe("GET /leads/:leadId", () => {
    it("tenant-scoped role + lead belongs to another tenant → 403, no body leak", async () => {
      const app = await setupApp("./leads", "tenant_user", 7);
      mockDb.selectResults = [[{ id: 42, tenantId: 9, firstName: "Foreign", lastName: "Lead", phone: "555" }]];
      const res = await request(app, "GET", "/leads/42");
      expect(res.status).toBe(403);
      expect(res.json).toEqual({ error: "Access denied" });
      expect(JSON.stringify(res.json)).not.toContain("Foreign");
    });

    it("tenant-scoped role + matching tenant → allowed", async () => {
      const app = await setupApp("./leads", "tenant_user", 7);
      mockDb.selectResults = [[{ id: 42, tenantId: 7, firstName: "Mine" }]];
      const res = await request(app, "GET", "/leads/42");
      expect(res.status).toBe(200);
      expect((res.json as { id: number }).id).toBe(42);
    });

    it("tenant-scoped role + no session.tenantId + lead exists → 403", async () => {
      const app = await setupApp("./leads", "tenant_user", null);
      mockDb.selectResults = [[{ id: 42, tenantId: 9, firstName: "Foreign" }]];
      const res = await request(app, "GET", "/leads/42");
      expect(res.status).toBe(403);
      expect(res.json).toEqual({ error: "No tenant assigned" });
    });

    it("super_admin reading a lead in any tenant → allowed", async () => {
      const app = await setupApp("./leads", "super_admin", null);
      mockDb.selectResults = [[{ id: 42, tenantId: 9, firstName: "Foreign" }]];
      const res = await request(app, "GET", "/leads/42");
      expect(res.status).toBe(200);
    });

    it("tenant-scoped role + lead missing but merged into a foreign-tenant lead → 403", async () => {
      const app = await setupApp("./leads", "tenant_user", 7);
      mockDb.selectResults = [
        [], // lead lookup misses
        [{ duplicateLeadId: 42, canonicalLeadId: 100, tenantId: 9, mergedAt: new Date(), source: "x", runId: "r" }],
      ];
      const res = await request(app, "GET", "/leads/42");
      expect(res.status).toBe(403);
      expect(res.json).toEqual({ error: "Access denied" });
      // The 410 "merged" payload (with canonicalLeadId 100) must NOT leak.
      expect(JSON.stringify(res.json)).not.toContain("100");
    });
  });

  describe("PATCH /leads/:leadId", () => {
    it("tenant-scoped role + lead belongs to another tenant → 403, no DB write", async () => {
      const app = await setupApp("./leads", "tenant_user", 7);
      mockDb.selectResults = [[{ tenantId: 9 }]];
      const res = await request(app, "PATCH", "/leads/42", { status: "contacted" });
      expect(res.status).toBe(403);
      expect(res.json).toEqual({ error: "Access denied" });
      const dbMod = await import("@workspace/db");
      expect(vi.mocked(dbMod.db.update)).not.toHaveBeenCalled();
    });

    it("tenant-scoped role + no session.tenantId → 403, no DB write", async () => {
      const app = await setupApp("./leads", "tenant_user", null);
      mockDb.selectResults = [[{ tenantId: 9 }]];
      const res = await request(app, "PATCH", "/leads/42", { status: "contacted" });
      expect(res.status).toBe(403);
      expect(res.json).toEqual({ error: "No tenant assigned" });
      const dbMod = await import("@workspace/db");
      expect(vi.mocked(dbMod.db.update)).not.toHaveBeenCalled();
    });
  });

  // GET /campaigns/:campaignId/breakdown — uses the 404-on-mismatch
  // option of the helper to avoid leaking existence.
  describe("GET /campaigns/:campaignId/breakdown", () => {
    it("tenant-scoped role + campaign belongs to another tenant → 404 (no existence leak)", async () => {
      const app = await setupApp("./campaigns", "tenant_user", 7);
      mockDb.selectResults = [[{ id: 5, tenantId: 9, platform: "meta", externalId: "x", name: "Foreign" }]];
      const res = await request(app, "GET", "/campaigns/5/breakdown");
      expect(res.status).toBe(404);
      expect(res.json).toEqual({ error: "Campaign not found" });
      // The campaign name must not have leaked.
      expect(JSON.stringify(res.json)).not.toContain("Foreign");
    });

    it("tenant-scoped role + no session.tenantId → 403", async () => {
      const app = await setupApp("./campaigns", "tenant_user", null);
      mockDb.selectResults = [[{ id: 5, tenantId: 9, platform: "meta", externalId: "x", name: "Foreign" }]];
      const res = await request(app, "GET", "/campaigns/5/breakdown");
      expect(res.status).toBe(403);
      expect(res.json).toEqual({ error: "No tenant assigned" });
    });
  });

  // GET /tenants/:id/funnel-types — caught in code review of task #393.
  // The handler trusted `:id` directly and queried tenant_funnel_types
  // associations, leaking another tenant's funnel-type configuration to
  // any tenant-scoped role that knew the foreign id.
  describe("GET /tenants/:id/funnel-types", () => {
    it("tenant-scoped role + foreign tenant id → 403, no DB read", async () => {
      const app = await setupApp("./funnel-types", "tenant_user", 7);
      const res = await request(app, "GET", "/tenants/9/funnel-types");
      expect(res.status).toBe(403);
      expect(res.json).toEqual({ error: "Access denied" });
      const dbMod = await import("@workspace/db");
      expect(vi.mocked(dbMod.db.select)).not.toHaveBeenCalled();
    });

    it("tenant-scoped role + no session.tenantId → 403, no DB read", async () => {
      const app = await setupApp("./funnel-types", "tenant_user", null);
      const res = await request(app, "GET", "/tenants/9/funnel-types");
      expect(res.status).toBe(403);
      expect(res.json).toEqual({ error: "No tenant assigned" });
      const dbMod = await import("@workspace/db");
      expect(vi.mocked(dbMod.db.select)).not.toHaveBeenCalled();
    });

    it("client_admin + own tenant id → allowed", async () => {
      const app = await setupApp("./funnel-types", "client_admin", 7);
      mockDb.selectResults = [[{ funnelTypeId: 1 }], [{ id: 1, name: "x" }]];
      const res = await request(app, "GET", "/tenants/7/funnel-types");
      expect(res.status).toBe(200);
    });

    it("super_admin + any tenant id → allowed", async () => {
      const app = await setupApp("./funnel-types", "super_admin", null);
      mockDb.selectResults = [[]];
      const res = await request(app, "GET", "/tenants/9/funnel-types");
      expect(res.status).toBe(200);
    });
  });
});
