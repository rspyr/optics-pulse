// Coverage for the rebate-program admin save flow on the tenants route.
//
// The rebate-pattern compilation logic is covered by
// `service-titan-rebates.test.ts`, but the admin *save path* — the
// `PATCH /tenants/:tenantId` endpoint that persists
// `revenueConfig.rebateLabels`, and the `GET` read that surfaces the
// seeded defaults — had no direct tests. This is the surface staff
// actually use, and it enforces several rules:
//   - only super_admin / agency_user may change revenue settings
//   - labels are trimmed, blanks dropped, de-duped case-insensitively
//   - each label must be <= 100 characters
//   - an effectively-empty list persists as [] (= "fall back to defaults")
//   - reads surface the seeded defaults with usingDefaults=true when the
//     tenant has no stored override
//
// The DB layer is mocked so these tests exercise the route's validation
// and normalization logic, not Postgres.

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

function makeSelectChain(results: () => unknown[]) {
  const chain: Record<string, unknown> = {};
  const passthrough = () => chain;
  chain.from = vi.fn().mockImplementation(passthrough);
  chain.where = vi.fn().mockImplementation(() => Promise.resolve(results()));
  chain.limit = vi.fn().mockImplementation(() => Promise.resolve(results()));
  chain.then = (resolve: Function, reject?: Function) =>
    Promise.resolve(results()).then(resolve as (v: unknown) => unknown, reject as (e: unknown) => unknown);
  return chain;
}

function makeUpdateChain(results: () => unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.set = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockReturnValue(chain);
  chain.returning = vi.fn().mockImplementation(() => Promise.resolve(results()));
  return chain;
}

let lastUpdateSetArg: Record<string, unknown> | null = null;

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
        const chain = makeUpdateChain(() => mockDb.updateResults[idx] || []);
        chain.set = vi.fn().mockImplementation((arg: Record<string, unknown>) => {
          lastUpdateSetArg = arg;
          return chain;
        });
        return chain;
      }),
    },
    tenantsTable: tablecol("tenants"),
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

vi.mock("../services/source-normalizer", () => ({
  DEFAULT_SOURCE_ALIASES: {},
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

describe("Rebate program admin save flow (PATCH/GET /tenants revenueConfig)", () => {
  beforeEach(() => {
    mockDb.reset();
    vi.clearAllMocks();
    lastUpdateSetArg = null;
  });

  describe("PATCH /tenants/:tenantId — role enforcement", () => {
    it("client_admin (own tenant) cannot modify revenue settings → 403, no DB write", async () => {
      const app = await setupApp("client_admin", 7);
      const res = await request(app, "PATCH", "/tenants/7", {
        revenueConfig: { rebateLabels: ["Custom Rebate"] },
      });
      expect(res.status).toBe(403);
      expect(res.json).toEqual({ error: "Only agency users can modify revenue settings" });
      const dbMod = await import("@workspace/db");
      expect(vi.mocked(dbMod.db.update)).not.toHaveBeenCalled();
    });
  });

  describe("PATCH /tenants/:tenantId — valid labels persisted", () => {
    it("agency_user saves a valid label list → persisted and echoed back", async () => {
      const app = await setupApp("agency_user", 1);
      // [0] existing tenant lookup inside the revenueConfig block
      // [1] (unused) — only one select before update here
      mockDb.selectResults = [[{ id: 7, revenueConfig: {} }]];
      mockDb.updateResults = [
        [{ id: 7, name: "Acme", apiConfig: null, revenueConfig: { rebateLabels: ["ETO", "Custom Program"] } }],
      ];
      const res = await request(app, "PATCH", "/tenants/7", {
        revenueConfig: { rebateLabels: ["ETO", "Custom Program"] },
      });
      expect(res.status).toBe(200);
      expect(lastUpdateSetArg?.revenueConfig).toEqual({ rebateLabels: ["ETO", "Custom Program"] });
      const json = res.json as { revenueConfig: { rebateLabels: string[]; usingDefaults: boolean } };
      expect(json.revenueConfig.rebateLabels).toEqual(["ETO", "Custom Program"]);
      expect(json.revenueConfig.usingDefaults).toBe(false);
    });
  });

  describe("PATCH /tenants/:tenantId — normalization", () => {
    it("trims, drops blanks, and de-dupes case-insensitively", async () => {
      const app = await setupApp("super_admin", null);
      mockDb.selectResults = [[{ id: 7, revenueConfig: {} }]];
      mockDb.updateResults = [[{ id: 7, apiConfig: null, revenueConfig: { rebateLabels: ["ETO", "ODEE"] } }]];
      const res = await request(app, "PATCH", "/tenants/7", {
        revenueConfig: { rebateLabels: ["  ETO  ", "", "eto", "ODEE", "   ", "odee"] },
      });
      expect(res.status).toBe(200);
      // First-seen casing wins; later case-insensitive dupes and blanks dropped.
      expect(lastUpdateSetArg?.revenueConfig).toEqual({ rebateLabels: ["ETO", "ODEE"] });
    });

    it("an all-blank list persists as [] (falls back to defaults on read)", async () => {
      const app = await setupApp("super_admin", null);
      mockDb.selectResults = [[{ id: 7, revenueConfig: { rebateLabels: ["Old"] } }]];
      mockDb.updateResults = [[{ id: 7, apiConfig: null, revenueConfig: { rebateLabels: [] } }]];
      const res = await request(app, "PATCH", "/tenants/7", {
        revenueConfig: { rebateLabels: ["", "   "] },
      });
      expect(res.status).toBe(200);
      expect(lastUpdateSetArg?.revenueConfig).toEqual({ rebateLabels: [] });
      const json = res.json as { revenueConfig: { rebateLabels: string[]; usingDefaults: boolean } };
      // The read path surfaces seeded defaults for an empty stored list.
      expect(json.revenueConfig.rebateLabels).toEqual(["ETO", "Energy Trust", "ODEE"]);
      expect(json.revenueConfig.usingDefaults).toBe(true);
    });
  });

  describe("PATCH /tenants/:tenantId — validation errors", () => {
    it("rejects an over-length label → 400, no DB write", async () => {
      const app = await setupApp("super_admin", null);
      const tooLong = "x".repeat(101);
      const res = await request(app, "PATCH", "/tenants/7", {
        revenueConfig: { rebateLabels: [tooLong] },
      });
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ error: "Each rebate label must be 100 characters or fewer" });
      const dbMod = await import("@workspace/db");
      expect(vi.mocked(dbMod.db.update)).not.toHaveBeenCalled();
    });

    it("rejects a non-array rebateLabels → 400, no DB write", async () => {
      const app = await setupApp("super_admin", null);
      const res = await request(app, "PATCH", "/tenants/7", {
        revenueConfig: { rebateLabels: "ETO" },
      });
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ error: "rebateLabels must be an array of strings" });
      const dbMod = await import("@workspace/db");
      expect(vi.mocked(dbMod.db.update)).not.toHaveBeenCalled();
    });

    it("rejects a non-string entry → 400, no DB write", async () => {
      const app = await setupApp("super_admin", null);
      const res = await request(app, "PATCH", "/tenants/7", {
        revenueConfig: { rebateLabels: ["ETO", 5] },
      });
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ error: "rebateLabels must be an array of strings" });
      const dbMod = await import("@workspace/db");
      expect(vi.mocked(dbMod.db.update)).not.toHaveBeenCalled();
    });
  });

  describe("GET /tenants/:tenantId — seeded defaults on read", () => {
    it("returns seeded defaults with usingDefaults=true when no override exists", async () => {
      const app = await setupApp("super_admin", null);
      mockDb.selectResults = [[{ id: 9, name: "Acme", apiConfig: null, revenueConfig: {} }]];
      const res = await request(app, "GET", "/tenants/9");
      expect(res.status).toBe(200);
      const json = res.json as { revenueConfig: { rebateLabels: string[]; usingDefaults: boolean } };
      expect(json.revenueConfig.rebateLabels).toEqual(["ETO", "Energy Trust", "ODEE"]);
      expect(json.revenueConfig.usingDefaults).toBe(true);
    });

    it("returns the stored override with usingDefaults=false", async () => {
      const app = await setupApp("super_admin", null);
      mockDb.selectResults = [
        [{ id: 9, name: "Acme", apiConfig: null, revenueConfig: { rebateLabels: ["Custom A", "Custom B"] } }],
      ];
      const res = await request(app, "GET", "/tenants/9");
      expect(res.status).toBe(200);
      const json = res.json as { revenueConfig: { rebateLabels: string[]; usingDefaults: boolean } };
      expect(json.revenueConfig.rebateLabels).toEqual(["Custom A", "Custom B"]);
      expect(json.revenueConfig.usingDefaults).toBe(false);
    });
  });
});
