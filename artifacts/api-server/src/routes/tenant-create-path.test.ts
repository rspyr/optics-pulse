// Coverage for the rest of the New Tenant onboarding create path on the
// tenants route. The Monthly Budget field on `POST /tenants` is covered in
// `tenant-create-budget.test.ts`; this file covers the remaining create-path
// behavior that previously had no automated coverage:
//   - name → unique client slug generation (slugify + numeric suffix on collision)
//   - timezone default ("America/New_York") when omitted, persisted when provided
//   - isDemo flag derived from the request body
//   - default source-alias seeding for the new tenant
//
// The DB layer is mocked so these tests exercise the route's create logic, not
// Postgres.

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

// Records the `.values(...)` arg of every insert (tenant row first, then one
// per seeded source alias) so tests can assert both the tenant insert and the
// alias-seeding loop.
let insertValuesArgs: Record<string, unknown>[] = [];

function makeInsertChain(results: () => unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.values = vi.fn().mockImplementation((arg: Record<string, unknown>) => {
    insertValuesArgs.push(arg);
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

// A small, deterministic alias set so the source-alias seeding loop emits a
// predictable, assertable number of inserts.
vi.mock("../services/source-normalizer", () => ({
  DEFAULT_SOURCE_ALIASES: [
    { canonicalName: "Meta", aliases: ["meta", "fb"] },
    { canonicalName: "Google", aliases: ["google"] },
  ],
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

// The first recorded insert is always the tenant row; the rest are seeded
// source aliases.
const tenantInsert = () => insertValuesArgs[0];
const aliasInserts = () => insertValuesArgs.slice(1);

describe("New tenant create flow (POST /tenants slug / timezone / isDemo / aliases)", () => {
  beforeEach(() => {
    mockDb.reset();
    vi.clearAllMocks();
    insertValuesArgs = [];
  });

  it("slugifies the name from the client name", async () => {
    const app = await setupApp("agency_user", 1);
    // Slug-uniqueness lookup returns empty → first candidate slug is free.
    mockDb.selectResults = [[]];
    mockDb.insertResults = [[{ id: 7, name: "Acme Plumbing & Co", apiConfig: null }]];
    const res = await request(app, "POST", "/tenants", { name: "Acme Plumbing & Co" });
    expect(res.status).toBe(201);
    expect(tenantInsert()?.name).toBe("Acme Plumbing & Co");
    expect(tenantInsert()?.clientSlug).toBe("acme-plumbing-co");
  });

  it("appends a numeric suffix when the base slug already exists", async () => {
    const app = await setupApp("agency_user", 1);
    // [0] "acme" is taken, [1] "acme-2" is taken, [2] "acme-3" is free.
    mockDb.selectResults = [[{ id: 1 }], [{ id: 2 }], []];
    mockDb.insertResults = [[{ id: 9, name: "Acme", apiConfig: null }]];
    const res = await request(app, "POST", "/tenants", { name: "Acme" });
    expect(res.status).toBe(201);
    expect(tenantInsert()?.clientSlug).toBe("acme-3");
  });

  it("defaults the timezone to America/New_York when omitted", async () => {
    const app = await setupApp("super_admin", null);
    mockDb.selectResults = [[]];
    mockDb.insertResults = [[{ id: 7, name: "Acme", apiConfig: null }]];
    const res = await request(app, "POST", "/tenants", { name: "Acme" });
    expect(res.status).toBe(201);
    expect(tenantInsert()?.timezone).toBe("America/New_York");
  });

  it("persists a provided timezone", async () => {
    const app = await setupApp("super_admin", null);
    mockDb.selectResults = [[]];
    mockDb.insertResults = [[{ id: 7, name: "Acme", apiConfig: null }]];
    const res = await request(app, "POST", "/tenants", { name: "Acme", timezone: "America/Los_Angeles" });
    expect(res.status).toBe(201);
    expect(tenantInsert()?.timezone).toBe("America/Los_Angeles");
  });

  it("sets isDemo from the request body (true)", async () => {
    const app = await setupApp("super_admin", null);
    mockDb.selectResults = [[]];
    mockDb.insertResults = [[{ id: 7, name: "Acme", apiConfig: null }]];
    const res = await request(app, "POST", "/tenants", { name: "Acme", isDemo: true });
    expect(res.status).toBe(201);
    expect(tenantInsert()?.isDemo).toBe(true);
  });

  it("defaults isDemo to false when omitted", async () => {
    const app = await setupApp("super_admin", null);
    mockDb.selectResults = [[]];
    mockDb.insertResults = [[{ id: 7, name: "Acme", apiConfig: null }]];
    const res = await request(app, "POST", "/tenants", { name: "Acme" });
    expect(res.status).toBe(201);
    expect(tenantInsert()?.isDemo).toBe(false);
  });

  it("seeds default source aliases for the new tenant", async () => {
    const app = await setupApp("agency_user", 1);
    mockDb.selectResults = [[]];
    mockDb.insertResults = [[{ id: 42, name: "Acme", apiConfig: null }]];
    const res = await request(app, "POST", "/tenants", { name: "Acme" });
    expect(res.status).toBe(201);
    // Mocked DEFAULT_SOURCE_ALIASES has 3 aliases total across 2 groups.
    const aliases = aliasInserts();
    expect(aliases).toHaveLength(3);
    // Every seeded alias is scoped to the newly created tenant and lowercased.
    for (const a of aliases) {
      expect(a.tenantId).toBe(42);
    }
    expect(aliases).toEqual([
      { tenantId: 42, canonicalName: "Meta", alias: "meta" },
      { tenantId: 42, canonicalName: "Meta", alias: "fb" },
      { tenantId: 42, canonicalName: "Google", alias: "google" },
    ]);
  });
});
