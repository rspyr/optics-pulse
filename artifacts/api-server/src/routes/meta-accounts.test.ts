import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { type Request, type Response, type NextFunction } from "express";
import http from "http";
import { encryptConfig, decryptConfig } from "../lib/encryption";

// ─── Db mock state ───────────────────────────────────────────────────────────

interface InsertCall { table: string; values: unknown[] }
interface UpdateCall { table: string; set: Record<string, unknown> }

const state = {
  selectQueue: [] as unknown[][],
  insertCalls: [] as InsertCall[],
  updateCalls: [] as UpdateCall[],
  reset() {
    this.selectQueue = [];
    this.insertCalls = [];
    this.updateCalls = [];
  },
};

function tableName(t: unknown): string {
  return (t as { __name?: string })?.__name || "unknown";
}

vi.mock("@workspace/db", () => {
  const tables = {
    tenantsTable: { __name: "tenants", id: "tenants.id" },
    metaAdAccountsTable: {
      __name: "meta_ad_accounts",
      id: "maa.id",
      tenantId: "maa.tenantId",
      accountId: "maa.accountId",
    },
  };

  function makeSelectChain() {
    const chain: Record<string, unknown> = {};
    const resolveResult = () =>
      Promise.resolve(state.selectQueue.length ? state.selectQueue.shift()! : []);
    chain.from = vi.fn().mockReturnValue(chain);
    chain.where = vi.fn().mockImplementation(resolveResult);
    chain.then = (r: Function) => resolveResult().then(r as (v: unknown) => unknown);
    return chain;
  }

  const db = {
    select: vi.fn().mockImplementation(() => makeSelectChain()),
    insert: vi.fn().mockImplementation((table: unknown) => ({
      values: vi.fn().mockImplementation((vals: unknown) => {
        const valsArr = Array.isArray(vals) ? vals : [vals];
        state.insertCalls.push({ table: tableName(table), values: valsArr });
        return Promise.resolve(undefined);
      }),
    })),
    update: vi.fn().mockImplementation((table: unknown) => ({
      set: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
        state.updateCalls.push({ table: tableName(table), set: vals });
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    })),
  };

  return { db, ...tables };
});

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...args: unknown[]) => ({ __op: "eq", args })),
  and: vi.fn((...args: unknown[]) => ({ __op: "and", args })),
}));

vi.mock("../middleware/auth", () => ({
  requireRole: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

// Mock MetaAPIService — keep the actual MetaTokenInvalidError so `instanceof` checks pass.
const metaMocks = vi.hoisted(() => ({
  listAdAccounts: (..._args: unknown[]) => Promise.resolve([]) as Promise<unknown>,
}));

vi.mock("../services/integrations/meta", async () => {
  const actual = await vi.importActual<typeof import("../services/integrations/meta")>(
    "../services/integrations/meta",
  );
  class MockMetaAPIService {
    listAdAccounts(...args: unknown[]) { return metaMocks.listAdAccounts(...args); }
  }
  return { ...actual, MetaAPIService: MockMetaAPIService };
});

// meta-accounts.ts imports backfillMetaCampaigns at module load — stub it.
vi.mock("../services/sync-scheduler", () => ({
  backfillMetaCampaigns: vi.fn().mockResolvedValue({ ok: true }),
}));

// ─── Test app + helpers ──────────────────────────────────────────────────────

let app: express.Express;

async function setupApp() {
  vi.resetModules();
  const mod = await import("./meta-accounts");
  app = express();
  app.use(express.json());
  app.use(mod.default);
}

interface HttpResponse { status: number; body: unknown }

function request(method: "GET" | "POST", path: string, body?: unknown): Promise<HttpResponse> {
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
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
            : {},
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            server.close();
            const text = Buffer.concat(chunks).toString("utf8");
            let parsed: unknown = text;
            try { parsed = text ? JSON.parse(text) : null; } catch { /* keep raw */ }
            resolve({ status: res.statusCode || 0, body: parsed });
          });
        },
      );
      req.on("error", (err) => { server.close(); reject(err); });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

beforeEach(() => {
  state.reset();
  metaMocks.listAdAccounts = () => Promise.resolve([]);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const baseTenant = {
  id: 7,
  name: "Acme",
  apiConfig: encryptConfig({ metaAccessToken: "tok-abc" }),
  metaNeedsReconnect: false,
  metaReconnectReason: null,
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("GET /integrations/meta/ad-accounts?refresh=1", () => {
  it("upserts newly discovered accounts and updates pre-existing ones", async () => {
    await setupApp();

    metaMocks.listAdAccounts = () => Promise.resolve([
      { id: "act_111", account_id: "111", name: "Acct A (renamed)", currency: "USD" },
      { id: "act_222", account_id: "222", name: "Acct B", currency: "EUR" },
    ]);

    // Selects in handler order under refresh=1:
    //   1. tenants (load)
    //   2. meta_ad_accounts (existing rows for upsert diff)
    //   3. meta_ad_accounts (final list returned in JSON)
    state.selectQueue.push([baseTenant]);
    state.selectQueue.push([
      { id: 99, tenantId: 7, accountId: "111", name: "Acct A", currency: "USD", isSelected: false, discoveredAt: new Date() },
    ]);
    state.selectQueue.push([
      { accountId: "111", name: "Acct A (renamed)", currency: "USD", isSelected: false, discoveredAt: new Date() },
      { accountId: "222", name: "Acct B", currency: "EUR", isSelected: false, discoveredAt: new Date() },
    ]);

    const res = await request("GET", "/integrations/meta/ad-accounts?tenantId=7&refresh=1");

    expect(res.status).toBe(200);
    const body = res.body as { accounts: Array<{ accountId: string }>; needsReconnect: boolean };
    expect(body.needsReconnect).toBe(false);
    expect(body.accounts.map((a) => a.accountId).sort()).toEqual(["111", "222"]);

    // The new account (222) was inserted; the existing one (111) was updated, not inserted.
    const inserts = state.insertCalls.filter((c) => c.table === "meta_ad_accounts");
    expect(inserts).toHaveLength(1);
    expect((inserts[0].values[0] as Record<string, unknown>).accountId).toBe("222");

    const accountUpdates = state.updateCalls.filter((u) => u.table === "meta_ad_accounts");
    expect(accountUpdates).toHaveLength(1);
    expect(accountUpdates[0].set.name).toBe("Acct A (renamed)");
  });

  it("flips metaNeedsReconnect and returns 401 when listAdAccounts throws MetaTokenInvalidError", async () => {
    await setupApp();
    const { MetaTokenInvalidError } = await import("../services/integrations/meta");

    metaMocks.listAdAccounts = () => Promise.reject(new MetaTokenInvalidError("token expired", 190, 463));

    state.selectQueue.push([baseTenant]); // tenant load

    const res = await request("GET", "/integrations/meta/ad-accounts?tenantId=7&refresh=1");

    expect(res.status).toBe(401);
    const body = res.body as { needsReconnect: boolean; error: string };
    expect(body.needsReconnect).toBe(true);
    expect(body.error).toMatch(/Reconnect required/);

    // Tenant was flipped to needs-reconnect.
    const tenantUpdates = state.updateCalls.filter((u) => u.table === "tenants");
    expect(tenantUpdates).toHaveLength(1);
    expect(tenantUpdates[0].set.metaNeedsReconnect).toBe(true);
    expect(tenantUpdates[0].set.metaReconnectReason).toBe("token expired");

    // No ad-account rows touched on the failure path.
    expect(state.insertCalls.filter((c) => c.table === "meta_ad_accounts")).toHaveLength(0);
    expect(state.updateCalls.filter((u) => u.table === "meta_ad_accounts")).toHaveLength(0);
  });
});

describe("POST /integrations/meta/ad-accounts/select", () => {
  it("clears prior selections, marks the chosen row, and writes metaAdAccountId into encrypted tenant config", async () => {
    await setupApp();

    state.selectQueue.push([baseTenant]); // tenant load
    state.selectQueue.push([
      { id: 42, tenantId: 7, accountId: "555", name: "Pick Me", currency: "USD", isSelected: false },
    ]); // ad-account lookup

    const res = await request("POST", "/integrations/meta/ad-accounts/select", {
      tenantId: 7,
      accountId: "act_555",
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, selectedAdAccountId: "act_555" });

    const accountUpdates = state.updateCalls.filter((u) => u.table === "meta_ad_accounts");
    expect(accountUpdates).toHaveLength(2);
    // First call clears all prior selections for the tenant.
    expect(accountUpdates[0].set).toEqual({ isSelected: false });
    // Second call marks the chosen row selected.
    expect(accountUpdates[1].set.isSelected).toBe(true);

    // Tenant config rewritten with the new metaAdAccountId, original token preserved.
    const tenantUpdates = state.updateCalls.filter((u) => u.table === "tenants");
    expect(tenantUpdates).toHaveLength(1);
    const finalConfig = decryptConfig(tenantUpdates[0].set.apiConfig as string);
    expect(finalConfig.metaAdAccountId).toBe("act_555");
    expect(finalConfig.metaAccessToken).toBe("tok-abc");
  });

  it("returns 404 and does not touch tenant config when the account is unknown", async () => {
    await setupApp();

    state.selectQueue.push([baseTenant]); // tenant load
    state.selectQueue.push([]); // ad-account lookup miss

    const res = await request("POST", "/integrations/meta/ad-accounts/select", {
      tenantId: 7,
      accountId: "act_999",
    });

    expect(res.status).toBe(404);
    expect((res.body as { error: string }).error).toMatch(/Ad account not found/);

    // No selection writes, no tenant config writes.
    expect(state.updateCalls.filter((u) => u.table === "meta_ad_accounts")).toHaveLength(0);
    expect(state.updateCalls.filter((u) => u.table === "tenants")).toHaveLength(0);
  });
});
