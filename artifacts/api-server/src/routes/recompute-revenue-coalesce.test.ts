// Verifies the two HTTP surfaces that trigger a ServiceTitan revenue recompute
// behave correctly when one is already in flight for the same tenant:
//
//   1. POST /integrations/service_titan/recompute-revenue (manual) → 409 with
//      { alreadyRunning: true } instead of stacking a duplicate full re-sync.
//   2. PATCH /tenants/:id with a changed rebate-program list → the
//      fire-and-forget auto-trigger is coalesced (logs "coalesced", no second
//      run) when a recompute is already running.
//
// Both routes share a single per-tenant advisory lock inside
// `recomputeServiceTitanRevenue`; here we mock that function to report
// `alreadyRunning` so we exercise the routes' handling of the coalesced result
// without touching Postgres.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Request, type Response, type NextFunction } from "express";
import http from "http";

// ─── Shared recompute mock ───────────────────────────────────────────────────

const recomputeMock = vi.fn();

vi.mock("../services/sync-scheduler", () => ({
  recomputeServiceTitanRevenue: (...args: unknown[]) => recomputeMock(...args),
  // Other named exports the routes import at module load.
  syncGoogleAdsCampaigns: vi.fn(),
  syncMetaCampaigns: vi.fn(),
  backfillGoogleAdsCampaigns: vi.fn(),
  backfillServiceTitanJobs: vi.fn(),
}));

// ─── DB + drizzle mocks ──────────────────────────────────────────────────────

const dbState = {
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

let lastUpdateSetArg: Record<string, unknown> | null = null;

function makeSelectChain(results: () => unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockImplementation(() => Promise.resolve(results()));
  chain.orderBy = vi.fn().mockReturnValue(chain);
  chain.limit = vi.fn().mockImplementation(() => Promise.resolve(results()));
  chain.then = (resolve: Function, reject?: Function) =>
    Promise.resolve(results()).then(resolve as (v: unknown) => unknown, reject as (e: unknown) => unknown);
  return chain;
}

function makeUpdateChain(results: () => unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.set = vi.fn().mockImplementation((arg: Record<string, unknown>) => {
    lastUpdateSetArg = arg;
    return chain;
  });
  chain.where = vi.fn().mockReturnValue(chain);
  chain.returning = vi.fn().mockImplementation(() => Promise.resolve(results()));
  return chain;
}

vi.mock("@workspace/db", () => {
  const tablecol = (t: string) => new Proxy({}, { get: (_: unknown, k: string) => `${t}.${String(k)}` });
  return {
    db: {
      select: vi.fn().mockImplementation(() => {
        const idx = dbState._selectIdx++;
        return makeSelectChain(() => dbState.selectResults[idx] || []);
      }),
      update: vi.fn().mockImplementation(() => {
        const idx = dbState._updateIdx++;
        return makeUpdateChain(() => dbState.updateResults[idx] || []);
      }),
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    },
    integrationSyncLogsTable: tablecol("integration_sync_logs"),
    tenantsTable: tablecol("tenants"),
    jobsTable: tablecol("jobs"),
    usersTable: tablecol("users"),
    leadSourceAliasesTable: tablecol("lead_source_aliases"),
    callrailWebhookStatusTable: tablecol("callrail_webhook_status"),
  };
});

function asAble(obj: Record<string, unknown>) {
  obj.as = vi.fn().mockReturnValue(obj);
  return obj;
}
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...a: unknown[]) => asAble({ __op: "eq", a })),
  and: vi.fn((...a: unknown[]) => asAble({ __op: "and", a })),
  desc: vi.fn((a: unknown) => asAble({ __op: "desc", a })),
  notInArray: vi.fn((...a: unknown[]) => asAble({ __op: "notInArray", a })),
  inArray: vi.fn((...a: unknown[]) => asAble({ __op: "inArray", a })),
  isNotNull: vi.fn((a: unknown) => asAble({ __op: "isNotNull", a })),
  isNull: vi.fn((a: unknown) => asAble({ __op: "isNull", a })),
  count: vi.fn((a: unknown) => asAble({ __op: "count", a })),
  sql: Object.assign(
    vi.fn((..._a: unknown[]) => asAble({ __op: "sql" })),
    { join: vi.fn((...a: unknown[]) => asAble({ __op: "sql.join", a })) },
  ),
}));

vi.mock("../lib/encryption", () => ({
  encryptConfig: vi.fn((v: unknown) => JSON.stringify(v)),
  decryptConfig: vi.fn(() => ({})),
}));

vi.mock("../services/source-normalizer", () => ({ DEFAULT_SOURCE_ALIASES: {} }));
vi.mock("../services/integrations/service-titan", () => ({
  DEFAULT_REBATE_LABELS: ["ETO", "Energy Trust", "ODEE"],
}));
vi.mock("../services/backfill-status-format", () => ({
  parseBackfillProgress: vi.fn(() => null),
  classifyBackfillError: vi.fn(() => null),
}));

// Auth: requireRole becomes a session-aware passthrough; tenant-scope helper
// always allows (these tests use agency_user / super_admin).
vi.mock("../middleware/auth", () => ({
  requireRole: (...roles: string[]) => (req: Request, res: Response, next: NextFunction) => {
    const sess = (req as unknown as { session?: { userRole?: string } }).session;
    if (!sess?.userRole || !roles.includes(sess.userRole)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }
    next();
  },
}));
vi.mock("../lib/tenant-scope", () => ({
  assertResourceTenantAccess: () => ({ ok: true }),
  NO_TENANT_ASSIGNED_ERROR: { error: "No tenant assigned" },
}));

// ─── HTTP helper ─────────────────────────────────────────────────────────────

function request(
  app: express.Express,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
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
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            server.close();
            resolve({ status: res.statusCode || 0, json: data ? JSON.parse(data) : {} });
          });
        },
      );
      req.on("error", (err) => {
        server.close();
        reject(err);
      });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

async function setupApp(routeModule: string, role: string, tenantId: number | null) {
  vi.resetModules();
  const mod = await import(routeModule);
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

const coalescedResult = {
  alreadyRunning: true as const,
  invoices: { synced: 0, error: "A revenue recompute is already running for this tenant" },
  estimates: { synced: 0, error: "skipped" },
};

beforeEach(() => {
  dbState.reset();
  recomputeMock.mockReset();
  lastUpdateSetArg = null;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

// ─── Manual recompute route ──────────────────────────────────────────────────

describe("POST /integrations/service_titan/recompute-revenue — coalescing", () => {
  it("returns 409 with alreadyRunning=true when a recompute is already in flight", async () => {
    recomputeMock.mockResolvedValue(coalescedResult);
    const app = await setupApp("./integrations", "agency_user", null);

    const res = await request(app, "POST", "/integrations/service_titan/recompute-revenue?tenantId=7");

    expect(res.status).toBe(409);
    expect(res.json.success).toBe(false);
    expect(res.json.alreadyRunning).toBe(true);
    expect(recomputeMock).toHaveBeenCalledTimes(1);
    expect(recomputeMock).toHaveBeenCalledWith(7);
  });

  it("returns 200 success when no recompute is already running", async () => {
    recomputeMock.mockResolvedValue({
      invoices: { synced: 3 },
      estimates: { synced: 5 },
    });
    const app = await setupApp("./integrations", "agency_user", null);

    const res = await request(app, "POST", "/integrations/service_titan/recompute-revenue?tenantId=7");

    expect(res.status).toBe(200);
    expect(res.json.success).toBe(true);
    expect(recomputeMock).toHaveBeenCalledTimes(1);
  });
});

// ─── Auto-trigger on rebate-label change ─────────────────────────────────────

describe("PATCH /tenants/:id rebate-label change — auto-trigger coalescing", () => {
  it("coalesces the fire-and-forget recompute when one is already running (still 200, single call, logs coalesced)", async () => {
    recomputeMock.mockResolvedValue(coalescedResult);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const app = await setupApp("./tenants", "agency_user", null);

    // [0] existing-tenant lookup inside the revenueConfig block (old labels
    //     differ from new → rebateLabelsChanged = true → auto-trigger fires).
    dbState.selectResults = [[{ id: 7, revenueConfig: { rebateLabels: ["OldLabel"] } }]];
    dbState.updateResults = [[{ id: 7, name: "Acme", apiConfig: null, revenueConfig: { rebateLabels: ["ETO"] } }]];

    const res = await request(app, "PATCH", "/tenants/7", {
      revenueConfig: { rebateLabels: ["ETO"] },
    });

    // The PATCH response is not blocked by the recompute; it returns 200.
    expect(res.status).toBe(200);

    // The recompute runs fire-and-forget AFTER the response is sent. Give the
    // microtask/`void (async () => …)()` a chance to run.
    await new Promise((r) => setTimeout(r, 20));

    expect(recomputeMock).toHaveBeenCalledTimes(1);
    expect(recomputeMock).toHaveBeenCalledWith(7);
    expect(logSpy.mock.calls.flat().some((m) => String(m).includes("coalesced"))).toBe(true);
  });

  it("does NOT trigger a recompute when the rebate list did not actually change", async () => {
    recomputeMock.mockResolvedValue(coalescedResult);
    const app = await setupApp("./tenants", "agency_user", null);

    // Stored labels equal the incoming labels → no change → no auto-trigger.
    dbState.selectResults = [[{ id: 7, revenueConfig: { rebateLabels: ["ETO"] } }]];
    dbState.updateResults = [[{ id: 7, name: "Acme", apiConfig: null, revenueConfig: { rebateLabels: ["ETO"] } }]];

    const res = await request(app, "PATCH", "/tenants/7", {
      revenueConfig: { rebateLabels: ["ETO"] },
    });

    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(recomputeMock).not.toHaveBeenCalled();
  });
});
