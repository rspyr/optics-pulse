// Coverage for the New Tenant onboarding create path on the tenants route.
//
// `POST /tenants` persists an optional per-client Monthly Budget to
// `tenants.monthly_budget`. The PATCH/GET budget surface is covered in
// `tenant-rebate-labels.test.ts`, but the *create* path had no direct
// tests, so a regression could silently stop saving the budget (or accept
// bad values) unnoticed. This file asserts:
//   - a valid whole-dollar budget is persisted on insert
//   - omitting / null leaves the column unset (defaults to fall back budget)
//   - negative or non-integer budgets are rejected with 400, no insert
//
// The DB layer is mocked so these tests exercise the route's validation
// logic, not Postgres.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDb = {
  selectResults: [] as unknown[][],
  insertResults: [] as unknown[][],
  _selectIdx: 0,
  _insertIdx: 0,
  reset() {
    this._selectIdx = 0;
    this._insertIdx = 0;
    this.selectResults = [];
    this.insertResults = [];
  },
};

function makeSelectChain(results: () => unknown[]) {
  const chain: Record<string, unknown> = {};
  const passthrough = () => chain;
  // The create path chains `.from().where().limit(1)` for slug uniqueness, so
  // every link returns the chain and the chain itself is awaitable.
  chain.from = vi.fn().mockImplementation(passthrough);
  chain.where = vi.fn().mockImplementation(passthrough);
  chain.limit = vi.fn().mockImplementation(passthrough);
  chain.then = (resolve: Function, reject?: Function) =>
    Promise.resolve(results()).then(resolve as (v: unknown) => unknown, reject as (e: unknown) => unknown);
  return chain;
}

let lastInsertValuesArg: Record<string, unknown> | null = null;

function makeInsertChain(results: () => unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.values = vi.fn().mockImplementation((arg: Record<string, unknown>) => {
    lastInsertValuesArg = arg;
    return chain;
  });
  chain.returning = vi.fn().mockImplementation(() => Promise.resolve(results()));
  // Source-alias seeding awaits `db.insert(...).values(...)` directly (no
  // .returning()), so the chain itself must be awaitable.
  chain.then = (resolve: Function, reject?: Function) =>
    Promise.resolve(results()).then(resolve as (v: unknown) => unknown, reject as (e: unknown) => unknown);
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
      insert: vi.fn().mockImplementation(() => {
        const idx = mockDb._insertIdx++;
        return makeInsertChain(() => mockDb.insertResults[idx] || []);
      }),
    },
    tenantsTable: tablecol("tenants"),
    usersTable: tablecol("users"),
    leadSourceAliasesTable: tablecol("lead_source_aliases"),
    callrailWebhookStatusTable: tablecol("callrail_webhook_status"),
    integrationSyncLogsTable: tablecol("integration_sync_logs"),
  };
});

function asAble(obj: Record<string, unknown>) {
  obj.as = vi.fn().mockReturnValue(obj);
  return obj;
}
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...a: unknown[]) => asAble({ __op: "eq", a })),
  and: vi.fn((...a: unknown[]) => asAble({ __op: "and", a })),
  sql: Object.assign(
    vi.fn((..._a: unknown[]) => asAble({ __op: "sql" })),
    { join: vi.fn((...a: unknown[]) => asAble({ __op: "sql.join", a })) },
  ),
}));

vi.mock("@workspace/api-zod", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return actual;
});

vi.mock("../lib/encryption", () => ({
  encryptConfig: vi.fn((v: unknown) => JSON.stringify(v)),
  decryptConfig: vi.fn(() => ({})),
}));

// Empty alias list keeps the create path's source-alias seeding loop a no-op.
vi.mock("../services/source-normalizer", () => ({
  DEFAULT_SOURCE_ALIASES: [],
}));

vi.mock("../services/integrations/service-titan", () => ({
  DEFAULT_REBATE_LABELS: ["ETO", "Energy Trust", "ODEE"],
}));

vi.mock("../middleware/auth", async () => {
  const actual = (await vi.importActual("../middleware/auth")) as Record<string, unknown>;
  return actual;
});

import express, { type Request, type Response, type NextFunction } from "express";

async function setupApp(role: string, tenantId: number | null) {
  vi.resetModules();
  const mod = await import("./tenants");
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

describe("New tenant create flow (POST /tenants monthlyBudget)", () => {
  beforeEach(() => {
    mockDb.reset();
    vi.clearAllMocks();
    lastInsertValuesArg = null;
  });

  it("agency_user creates a tenant with a whole-dollar budget → persisted on insert", async () => {
    const app = await setupApp("agency_user", 1);
    // [0] slug-uniqueness lookup → empty so the first candidate slug is used.
    mockDb.selectResults = [[]];
    mockDb.insertResults = [[{ id: 7, name: "Acme", apiConfig: null, monthlyBudget: 25000 }]];
    const res = await request(app, "POST", "/tenants", { name: "Acme", monthlyBudget: 25000 });
    expect(res.status).toBe(201);
    expect(lastInsertValuesArg?.monthlyBudget).toBe(25000);
    const json = res.json as { monthlyBudget: number };
    expect(json.monthlyBudget).toBe(25000);
  });

  it("omitting monthlyBudget leaves the column unset (falls back to default)", async () => {
    const app = await setupApp("agency_user", 1);
    mockDb.selectResults = [[]];
    mockDb.insertResults = [[{ id: 7, name: "Acme", apiConfig: null, monthlyBudget: null }]];
    const res = await request(app, "POST", "/tenants", { name: "Acme" });
    expect(res.status).toBe(201);
    // No monthlyBudget key is written, so the DB default applies.
    expect(lastInsertValuesArg).not.toBeNull();
    expect("monthlyBudget" in (lastInsertValuesArg as Record<string, unknown>)).toBe(false);
  });

  it("explicit null monthlyBudget leaves the column unset (falls back to default)", async () => {
    const app = await setupApp("super_admin", null);
    mockDb.selectResults = [[]];
    mockDb.insertResults = [[{ id: 7, name: "Acme", apiConfig: null, monthlyBudget: null }]];
    const res = await request(app, "POST", "/tenants", { name: "Acme", monthlyBudget: null });
    expect(res.status).toBe(201);
    expect("monthlyBudget" in (lastInsertValuesArg as Record<string, unknown>)).toBe(false);
  });

  it("rejects a negative budget → 400, no insert", async () => {
    const app = await setupApp("super_admin", null);
    mockDb.selectResults = [[]];
    const res = await request(app, "POST", "/tenants", { name: "Acme", monthlyBudget: -5 });
    expect(res.status).toBe(400);
    const dbMod = await import("@workspace/db");
    expect(vi.mocked(dbMod.db.insert)).not.toHaveBeenCalled();
  });

  it("rejects a non-integer budget → 400, no insert", async () => {
    const app = await setupApp("super_admin", null);
    mockDb.selectResults = [[]];
    const res = await request(app, "POST", "/tenants", { name: "Acme", monthlyBudget: 99.5 });
    expect(res.status).toBe(400);
    const dbMod = await import("@workspace/db");
    expect(vi.mocked(dbMod.db.insert)).not.toHaveBeenCalled();
  });
});
