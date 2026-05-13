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
    const resolveResult = () => Promise.resolve(state.selectQueue.length ? state.selectQueue.shift()! : []);
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

// Mock MetaAPIService — we control verifyToken + listAdAccounts.
const metaMocks = vi.hoisted(() => ({
  verifyToken: (..._args: unknown[]) => Promise.resolve({ id: "fb-user" }) as Promise<unknown>,
  listAdAccounts: (..._args: unknown[]) => Promise.resolve([]) as Promise<unknown>,
}));

vi.mock("../services/integrations/meta", async () => {
  const actual = await vi.importActual<typeof import("../services/integrations/meta")>(
    "../services/integrations/meta",
  );
  class MockMetaAPIService {
    verifyToken(...args: unknown[]) { return metaMocks.verifyToken(...args); }
    listAdAccounts(...args: unknown[]) { return metaMocks.listAdAccounts(...args); }
  }
  return { ...actual, MetaAPIService: MockMetaAPIService };
});

// ─── Test app + helpers ──────────────────────────────────────────────────────

let app: express.Express;

async function setupApp(session: Record<string, unknown>) {
  vi.resetModules();
  const mod = await import("./meta-oauth");
  app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { session: Record<string, unknown> }).session = session;
    next();
  });
  app.use(mod.default);
}

function getNoFollow(path: string): Promise<{ status: number; location?: string }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      const req = http.request(
        { hostname: "127.0.0.1", port, path, method: "GET" },
        (res) => {
          res.resume();
          res.on("end", () => {
            server.close();
            resolve({ status: res.statusCode || 0, location: res.headers.location });
          });
        },
      );
      req.on("error", (err) => { server.close(); reject(err); });
      req.end();
    });
  });
}

beforeEach(() => {
  state.reset();
  process.env.META_APP_ID = "test-app-id";
  process.env.META_APP_SECRET = "test-app-secret";
  metaMocks.verifyToken = () => Promise.resolve({ id: "fb-user", name: "Test User" });
  metaMocks.listAdAccounts = () => Promise.resolve([]);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Stub global fetch for Meta token-exchange calls.
function stubTokenExchange() {
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL) => {
    calls.push(String(url));
    return new Response(
      JSON.stringify({ access_token: "long-lived-token", token_type: "bearer", expires_in: 5184000 }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  return calls;
}

const baseTenant = {
  id: 7,
  name: "Acme",
  apiConfig: encryptConfig({}),
  metaNeedsReconnect: false,
  metaReconnectReason: null,
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("GET /oauth/meta/callback — ad-account discovery + auto-select", () => {
  it("auto-selects the only discovered ad account, persists token, and clears reconnect flag", async () => {
    await setupApp({
      userId: 1,
      metaOAuthState: "abc123",
      metaOAuthTenantId: 7,
    });
    stubTokenExchange();

    metaMocks.listAdAccounts = () => Promise.resolve([
      { id: "act_555", account_id: "555", name: "Acme Ads", currency: "USD" },
    ]);

    // Selects in callback handler order:
    //   1. tenants (load tenant) inside try block
    //   2. meta_ad_accounts (existing list before upsert) — empty
    state.selectQueue.push([baseTenant]);
    state.selectQueue.push([]);

    const res = await getNoFollow("/oauth/meta/callback?code=auth-code&state=abc123");

    expect(res.status).toBe(302);
    expect(res.location).toMatch(/metaOAuth=success/);
    expect(res.location).toMatch(/tenantId=7/);
    // Single account → auto-select, no pickAccount flag
    expect(res.location).not.toMatch(/pickAccount=1/);

    // Inserted the one discovered account.
    const inserts = state.insertCalls.filter((c) => c.table === "meta_ad_accounts");
    expect(inserts).toHaveLength(1);
    expect((inserts[0].values[0] as Record<string, unknown>).accountId).toBe("555");

    // Tenant updated twice: first to set token + clear reconnect, second to persist auto-selected account id.
    const tenantUpdates = state.updateCalls.filter((u) => u.table === "tenants");
    expect(tenantUpdates.length).toBeGreaterThanOrEqual(2);

    const firstTenantUpdate = tenantUpdates[0];
    expect(firstTenantUpdate.set.metaNeedsReconnect).toBe(false);
    expect(firstTenantUpdate.set.metaReconnectReason).toBeNull();
    const tokenConfig = decryptConfig(firstTenantUpdate.set.apiConfig as string);
    expect(tokenConfig.metaAccessToken).toBe("long-lived-token");

    // Auto-select marks the row + writes metaAdAccountId into config.
    const acctSelectUpdate = state.updateCalls.find(
      (u) => u.table === "meta_ad_accounts" && u.set.isSelected === true,
    );
    expect(acctSelectUpdate).toBeDefined();

    const secondTenantUpdate = tenantUpdates[tenantUpdates.length - 1];
    const finalConfig = decryptConfig(secondTenantUpdate.set.apiConfig as string);
    expect(finalConfig.metaAdAccountId).toBe("act_555");
  });

  it("does NOT auto-select when multiple ad accounts are discovered, and signals pickAccount=1", async () => {
    await setupApp({
      userId: 1,
      metaOAuthState: "abc123",
      metaOAuthTenantId: 7,
    });
    stubTokenExchange();

    metaMocks.listAdAccounts = () => Promise.resolve([
      { id: "act_111", account_id: "111", name: "Acct A", currency: "USD" },
      { id: "act_222", account_id: "222", name: "Acct B", currency: "USD" },
    ]);

    state.selectQueue.push([baseTenant]); // tenant
    state.selectQueue.push([]); // existing ad accounts

    const res = await getNoFollow("/oauth/meta/callback?code=auth-code&state=abc123");

    expect(res.status).toBe(302);
    expect(res.location).toMatch(/metaOAuth=success/);
    expect(res.location).toMatch(/pickAccount=1/);

    // Both accounts inserted.
    const inserts = state.insertCalls.filter((c) => c.table === "meta_ad_accounts");
    expect(inserts).toHaveLength(2);

    // No row was marked selected.
    const acctSelectUpdate = state.updateCalls.find(
      (u) => u.table === "meta_ad_accounts" && u.set.isSelected === true,
    );
    expect(acctSelectUpdate).toBeUndefined();

    // Token was still persisted.
    const tenantUpdates = state.updateCalls.filter((u) => u.table === "tenants");
    expect(tenantUpdates.length).toBe(1);
    const cfg = decryptConfig(tenantUpdates[0].set.apiConfig as string);
    expect(cfg.metaAccessToken).toBe("long-lived-token");
    expect(cfg.metaAdAccountId).toBeUndefined();
  });

  it("redirects to invalid_state when session state does not match", async () => {
    await setupApp({
      userId: 1,
      metaOAuthState: "expected-state",
      metaOAuthTenantId: 7,
    });
    stubTokenExchange();

    const res = await getNoFollow("/oauth/meta/callback?code=auth-code&state=wrong-state");

    expect(res.status).toBe(302);
    expect(res.location).toMatch(/metaOAuth=error/);
    expect(res.location).toMatch(/invalid_state/);
    // No DB writes attempted.
    expect(state.insertCalls).toHaveLength(0);
    expect(state.updateCalls).toHaveLength(0);
  });
});
