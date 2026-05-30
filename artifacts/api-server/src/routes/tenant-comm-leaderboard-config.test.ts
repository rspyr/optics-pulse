// Coverage for the communication / leaderboard / alert config save flow on the
// tenants route.
//
// Task #776 added direct tests for the integrationConfig credential
// merge/mask branch of `PATCH /tenants/:tenantId`, but the sibling config
// blocks on the same endpoint had none:
//   - communicationConfig: validates callPlatform / textPlatform against an
//     allow-list (400 on an invalid value, before any DB write) and merges the
//     submitted fields onto the tenant's existing stored config so an unrelated
//     key is never clobbered.
//   - leaderboardConfig: role-gated (only super_admin / agency_user may change
//     it), coerces `visible` to a boolean, accepts displayMode only from an
//     allow-list (invalid values are silently dropped), and merges onto the
//     existing config.
//   - alertConfig: passthrough — any object is stored as-is.
//
// These share the exact merge-onto-existing pattern that previously bit the
// integrationConfig branch, so a regression could silently drop a saved setting
// or accept an invalid platform value. The DB and encryption layers are mocked
// (the harness mirrors `tenant-integration-config.test.ts`) so these tests
// exercise the route's validation / merge logic, not Postgres.

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

describe("Communication / leaderboard / alert config save flow (PATCH /tenants)", () => {
  beforeEach(() => {
    mockDb.reset();
    vi.clearAllMocks();
    lastUpdateSetArg = null;
  });

  describe("communicationConfig — invalid platform values are rejected", () => {
    it("returns 400 and writes nothing for an invalid callPlatform", async () => {
      const app = await setupApp("agency_user", null);
      const res = await request(app, "PATCH", "/tenants/7", {
        communicationConfig: { callPlatform: "carrier-pigeon" },
      });

      expect(res.status).toBe(400);
      expect((res.json as { error: string }).error).toMatch(/Invalid callPlatform/);
      // Validation happens before any DB read/write, so nothing was persisted.
      expect(lastUpdateSetArg).toBeNull();
    });

    it("returns 400 and writes nothing for an invalid textPlatform", async () => {
      const app = await setupApp("agency_user", null);
      const res = await request(app, "PATCH", "/tenants/7", {
        communicationConfig: { textPlatform: "smoke-signal" },
      });

      expect(res.status).toBe(400);
      expect((res.json as { error: string }).error).toMatch(/Invalid textPlatform/);
      expect(lastUpdateSetArg).toBeNull();
    });

    it("rejects an invalid value even when the sibling field is valid", async () => {
      const app = await setupApp("agency_user", null);
      const res = await request(app, "PATCH", "/tenants/7", {
        communicationConfig: { callPlatform: "callrail", textPlatform: "nope" },
      });

      expect(res.status).toBe(400);
      expect((res.json as { error: string }).error).toMatch(/Invalid textPlatform/);
      expect(lastUpdateSetArg).toBeNull();
    });
  });

  describe("communicationConfig — valid fields merge onto the existing config", () => {
    it("updates only the submitted field and preserves the other stored platform", async () => {
      const app = await setupApp("agency_user", null);
      // [0] existingForComm lookup inside the communicationConfig branch.
      mockDb.selectResults = [
        [{ id: 7, communicationConfig: { callPlatform: "native", textPlatform: "podium" } }],
      ];
      mockDb.updateResults = [[{ id: 7, name: "Acme", communicationConfig: { callPlatform: "callrail", textPlatform: "podium" } }]];

      const res = await request(app, "PATCH", "/tenants/7", {
        communicationConfig: { callPlatform: "callrail" },
      });

      expect(res.status).toBe(200);
      // Only callPlatform changed; the stored textPlatform was not clobbered.
      expect(lastUpdateSetArg?.communicationConfig).toEqual({
        callPlatform: "callrail",
        textPlatform: "podium",
      });
    });

    it("does not drop unrelated keys already present in the stored config", async () => {
      const app = await setupApp("super_admin", null);
      mockDb.selectResults = [
        [{ id: 7, communicationConfig: { callPlatform: "native", textPlatform: "native", somethingElse: "keep-me" } }],
      ];
      mockDb.updateResults = [[{ id: 7, communicationConfig: {} }]];

      const res = await request(app, "PATCH", "/tenants/7", {
        communicationConfig: { textPlatform: "callrail" },
      });

      expect(res.status).toBe(200);
      expect(lastUpdateSetArg?.communicationConfig).toEqual({
        callPlatform: "native",
        textPlatform: "callrail",
        somethingElse: "keep-me",
      });
    });

    it("sets both platforms when both valid values are submitted onto an empty config", async () => {
      const app = await setupApp("super_admin", null);
      mockDb.selectResults = [[{ id: 7, communicationConfig: null }]];
      mockDb.updateResults = [[{ id: 7, communicationConfig: {} }]];

      const res = await request(app, "PATCH", "/tenants/7", {
        communicationConfig: { callPlatform: "none", textPlatform: "podium" },
      });

      expect(res.status).toBe(200);
      expect(lastUpdateSetArg?.communicationConfig).toEqual({
        callPlatform: "none",
        textPlatform: "podium",
      });
    });
  });

  describe("leaderboardConfig — role enforcement", () => {
    it("rejects a client_admin with 403 and writes nothing", async () => {
      // client_admin passes the PATCH role gate and same-tenant access check,
      // but the leaderboard branch is restricted to agency staff.
      const app = await setupApp("client_admin", 7);
      const res = await request(app, "PATCH", "/tenants/7", {
        leaderboardConfig: { visible: true },
      });

      expect(res.status).toBe(403);
      expect((res.json as { error: string }).error).toMatch(/Only agency users can modify leaderboard/);
      expect(lastUpdateSetArg).toBeNull();
    });

    it("allows a super_admin to change leaderboard settings", async () => {
      const app = await setupApp("super_admin", null);
      mockDb.selectResults = [[{ id: 7, leaderboardConfig: { visible: false, displayMode: "anonymized" } }]];
      mockDb.updateResults = [[{ id: 7, leaderboardConfig: {} }]];

      const res = await request(app, "PATCH", "/tenants/7", {
        leaderboardConfig: { visible: true, displayMode: "named" },
      });

      expect(res.status).toBe(200);
      expect(lastUpdateSetArg?.leaderboardConfig).toEqual({
        visible: true,
        displayMode: "named",
      });
    });
  });

  describe("leaderboardConfig — valid fields merge onto the existing config", () => {
    it("coerces visible to a boolean and preserves the unchanged displayMode", async () => {
      const app = await setupApp("agency_user", null);
      mockDb.selectResults = [[{ id: 7, leaderboardConfig: { visible: false, displayMode: "named" } }]];
      mockDb.updateResults = [[{ id: 7, leaderboardConfig: {} }]];

      const res = await request(app, "PATCH", "/tenants/7", {
        leaderboardConfig: { visible: 1 },
      });

      expect(res.status).toBe(200);
      // visible coerced to a real boolean; the stored displayMode untouched.
      expect(lastUpdateSetArg?.leaderboardConfig).toEqual({
        visible: true,
        displayMode: "named",
      });
    });

    it("silently ignores an invalid displayMode while still applying visible", async () => {
      const app = await setupApp("agency_user", null);
      mockDb.selectResults = [[{ id: 7, leaderboardConfig: { visible: false, displayMode: "anonymized" } }]];
      mockDb.updateResults = [[{ id: 7, leaderboardConfig: {} }]];

      const res = await request(app, "PATCH", "/tenants/7", {
        leaderboardConfig: { visible: true, displayMode: "bogus" },
      });

      expect(res.status).toBe(200);
      // Invalid displayMode dropped → existing value preserved; visible applied.
      expect(lastUpdateSetArg?.leaderboardConfig).toEqual({
        visible: true,
        displayMode: "anonymized",
      });
    });

    it("does not drop unrelated keys already present in the stored config", async () => {
      const app = await setupApp("super_admin", null);
      mockDb.selectResults = [[{ id: 7, leaderboardConfig: { visible: true, displayMode: "named", legacyFlag: "keep" } }]];
      mockDb.updateResults = [[{ id: 7, leaderboardConfig: {} }]];

      const res = await request(app, "PATCH", "/tenants/7", {
        leaderboardConfig: { displayMode: "anonymized" },
      });

      expect(res.status).toBe(200);
      expect(lastUpdateSetArg?.leaderboardConfig).toEqual({
        visible: true,
        displayMode: "anonymized",
        legacyFlag: "keep",
      });
    });
  });

  describe("alertConfig — passthrough", () => {
    it("stores the submitted alertConfig object as-is", async () => {
      const app = await setupApp("super_admin", null);
      mockDb.updateResults = [[{ id: 7, name: "Acme", alertConfig: null }]];

      const alertConfig = { budgetOverage: true, threshold: 90, channels: ["email", "sms"] };
      const res = await request(app, "PATCH", "/tenants/7", { alertConfig });

      expect(res.status).toBe(200);
      expect(lastUpdateSetArg?.alertConfig).toEqual(alertConfig);
    });
  });
});
