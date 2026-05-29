// Coverage for the integration-credential merge/mask flow on the tenants route.
//
// `PATCH /tenants/:tenantId` has a sizeable integrationConfig branch that:
//   - decrypts the tenant's existing stored config
//   - merges in the newly submitted fields
//   - skips already-masked placeholder values (`••••`/`****` prefixes) so a
//     round-tripped secret from the UI doesn't overwrite the real one
//   - clears fields set to "" or "__CLEAR__"
//   - re-encrypts the merged result
// and the read path (`sanitizeTenant`, used by GET/PATCH responses) masks
// every SECRET_FIELDS value (`****1234`) and exposes a loadable placeholder
// (`••••1234`) but never the raw secret.
//
// None of this had direct tests, so a regression could silently drop a saved
// API key or leak a secret in a response. These tests exercise the route's
// merge/mask logic with the DB and encryption mocked. The encryption mock
// round-trips JSON (encrypt = JSON.stringify, decrypt = JSON.parse) so the
// merge can read back what was stored without doing real crypto.

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

// Round-trip JSON so the merge can decrypt the existing stored config and we
// can inspect what was re-encrypted, without doing real AES.
vi.mock("../lib/encryption", () => ({
  encryptConfig: vi.fn((v: Record<string, unknown>) => JSON.stringify(v)),
  decryptConfig: vi.fn((s: string) => JSON.parse(s)),
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

// Helper: the stored apiConfig column holds whatever encryptConfig produced —
// here a JSON string. Mirrors how a real row would carry the encrypted blob.
const stored = (cfg: Record<string, unknown>) => JSON.stringify(cfg);

describe("Integration credential merge/mask flow (PATCH/GET /tenants integrationConfig)", () => {
  beforeEach(() => {
    mockDb.reset();
    vi.clearAllMocks();
    lastUpdateSetArg = null;
  });

  describe("PATCH /tenants/:tenantId — merge onto existing config", () => {
    it("merges new fields onto the existing decrypted config and re-encrypts", async () => {
      const app = await setupApp("agency_user", 1);
      // [0] existing tenant lookup inside the integrationConfig branch
      mockDb.selectResults = [
        [{ id: 7, apiConfig: stored({ callRailApiKey: "oldcall9999", googleAdsClientId: "client0001" }) }],
      ];
      mockDb.updateResults = [[{ id: 7, name: "Acme", apiConfig: null }]];

      const res = await request(app, "PATCH", "/tenants/7", {
        integrationConfig: { metaAccessToken: "newtoken5678" },
      });

      expect(res.status).toBe(200);
      // apiConfig set on update = encryptConfig(mergedConfig) = JSON string.
      const merged = JSON.parse(lastUpdateSetArg?.apiConfig as string);
      expect(merged).toEqual({
        callRailApiKey: "oldcall9999",
        googleAdsClientId: "client0001",
        metaAccessToken: "newtoken5678",
      });
    });

    it("overwrites an existing field when a fresh (unmasked) value is submitted", async () => {
      const app = await setupApp("super_admin", null);
      mockDb.selectResults = [[{ id: 7, apiConfig: stored({ googleAdsApiKey: "oldkey1111" }) }]];
      mockDb.updateResults = [[{ id: 7, apiConfig: null }]];

      const res = await request(app, "PATCH", "/tenants/7", {
        integrationConfig: { googleAdsApiKey: "freshkey2222" },
      });

      expect(res.status).toBe(200);
      const merged = JSON.parse(lastUpdateSetArg?.apiConfig as string);
      expect(merged).toEqual({ googleAdsApiKey: "freshkey2222" });
    });

    it("starts from an empty config when the tenant has none stored", async () => {
      const app = await setupApp("super_admin", null);
      mockDb.selectResults = [[{ id: 7, apiConfig: null }]];
      mockDb.updateResults = [[{ id: 7, apiConfig: null }]];

      const res = await request(app, "PATCH", "/tenants/7", {
        integrationConfig: { podiumApiToken: "podtok4444" },
      });

      expect(res.status).toBe(200);
      const merged = JSON.parse(lastUpdateSetArg?.apiConfig as string);
      expect(merged).toEqual({ podiumApiToken: "podtok4444" });
    });
  });

  describe("PATCH /tenants/:tenantId — masked placeholders are ignored", () => {
    it("preserves the stored secret when an incoming `••••1234` placeholder is submitted", async () => {
      const app = await setupApp("agency_user", 1);
      mockDb.selectResults = [[{ id: 7, apiConfig: stored({ googleAdsApiKey: "realsecret4321" }) }]];
      mockDb.updateResults = [[{ id: 7, apiConfig: null }]];

      const res = await request(app, "PATCH", "/tenants/7", {
        integrationConfig: { googleAdsApiKey: "••••4321", callRailApiKey: "newcall0000" },
      });

      expect(res.status).toBe(200);
      const merged = JSON.parse(lastUpdateSetArg?.apiConfig as string);
      // Masked value skipped → original secret preserved; the genuinely-new
      // field is still merged in.
      expect(merged).toEqual({
        googleAdsApiKey: "realsecret4321",
        callRailApiKey: "newcall0000",
      });
    });

    it("also ignores the `****1234` placeholder prefix", async () => {
      const app = await setupApp("super_admin", null);
      mockDb.selectResults = [[{ id: 7, apiConfig: stored({ metaAccessToken: "metatoken8888" }) }]];
      mockDb.updateResults = [[{ id: 7, apiConfig: null }]];

      const res = await request(app, "PATCH", "/tenants/7", {
        integrationConfig: { metaAccessToken: "****8888" },
      });

      expect(res.status).toBe(200);
      const merged = JSON.parse(lastUpdateSetArg?.apiConfig as string);
      expect(merged).toEqual({ metaAccessToken: "metatoken8888" });
    });
  });

  describe("PATCH /tenants/:tenantId — clearing fields", () => {
    it('deletes a field set to "" and a field set to "__CLEAR__", keeping the rest', async () => {
      const app = await setupApp("super_admin", null);
      mockDb.selectResults = [
        [
          {
            id: 7,
            apiConfig: stored({
              googleAdsApiKey: "aaa1111",
              callRailApiKey: "bbb2222",
              metaAccessToken: "ccc3333",
            }),
          },
        ],
      ];
      mockDb.updateResults = [[{ id: 7, apiConfig: null }]];

      const res = await request(app, "PATCH", "/tenants/7", {
        integrationConfig: { googleAdsApiKey: "", callRailApiKey: "__CLEAR__" },
      });

      expect(res.status).toBe(200);
      const merged = JSON.parse(lastUpdateSetArg?.apiConfig as string);
      expect(merged).toEqual({ metaAccessToken: "ccc3333" });
    });
  });

  describe("PATCH /tenants/:tenantId — response masks secrets", () => {
    it("masks SECRET_FIELDS in the PATCH response and never echoes the raw secret", async () => {
      const app = await setupApp("super_admin", null);
      mockDb.selectResults = [[{ id: 7, apiConfig: stored({ googleAdsApiKey: "oldkey1111" }) }]];
      // The updated row carries the merged, encrypted config back out.
      mockDb.updateResults = [
        [{ id: 7, name: "Acme", apiConfig: stored({ googleAdsApiKey: "freshsecret9876" }) }],
      ];

      const res = await request(app, "PATCH", "/tenants/7", {
        integrationConfig: { googleAdsApiKey: "freshsecret9876" },
      });

      expect(res.status).toBe(200);
      const json = res.json as {
        apiConfig: Record<string, string>;
        loadableConfig: Record<string, string>;
      };
      expect(json.apiConfig.googleAdsApiKey).toBe("****9876");
      expect(json.loadableConfig.googleAdsApiKey).toBe("••••9876");
      // The raw secret must never appear anywhere in the serialized response.
      expect(JSON.stringify(json)).not.toContain("freshsecret9876");
    });
  });

  describe("GET /tenants/:tenantId — response masks secrets", () => {
    it("masks SECRET_FIELDS, exposes loadable placeholders, and never echoes the raw secret", async () => {
      const app = await setupApp("super_admin", null);
      mockDb.selectResults = [
        [
          {
            id: 9,
            name: "Acme",
            apiConfig: stored({ googleAdsApiKey: "supersecret9876", metaAccessToken: "tok5555" }),
          },
        ],
      ];

      const res = await request(app, "GET", "/tenants/9");

      expect(res.status).toBe(200);
      const json = res.json as {
        apiConfig: Record<string, string>;
        loadableConfig: Record<string, string>;
        hasIntegrationConfig: boolean;
      };
      expect(json.hasIntegrationConfig).toBe(true);
      expect(json.apiConfig.googleAdsApiKey).toBe("****9876");
      expect(json.apiConfig.metaAccessToken).toBe("****5555");
      expect(json.loadableConfig.googleAdsApiKey).toBe("••••9876");
      expect(json.loadableConfig.metaAccessToken).toBe("••••5555");
      expect(JSON.stringify(json)).not.toContain("supersecret9876");
      expect(JSON.stringify(json)).not.toContain("tok5555");
    });

    it("leaves non-secret config fields unmasked", async () => {
      const app = await setupApp("super_admin", null);
      mockDb.selectResults = [
        [
          {
            id: 9,
            name: "Acme",
            apiConfig: stored({ googleAdsCustomerId: "123-456-7890", googleAdsApiKey: "secretkey4321" }),
          },
        ],
      ];

      const res = await request(app, "GET", "/tenants/9");

      expect(res.status).toBe(200);
      const json = res.json as { apiConfig: Record<string, string> };
      // Not in SECRET_FIELDS → passed through verbatim.
      expect(json.apiConfig.googleAdsCustomerId).toBe("123-456-7890");
      // In SECRET_FIELDS → masked.
      expect(json.apiConfig.googleAdsApiKey).toBe("****4321");
    });
  });
});
