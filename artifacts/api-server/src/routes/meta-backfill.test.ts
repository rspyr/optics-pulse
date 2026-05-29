import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { type Request, type Response, type NextFunction } from "express";
import http from "http";
import { encryptConfig } from "../lib/encryption";

// ─── Db mock state ───────────────────────────────────────────────────────────

interface InsertCall { table: string; values: unknown[]; onConflict?: "update" | "nothing" }
interface UpdateCall { table: string; set: Record<string, unknown> }

const state = {
  selectQueue: [] as unknown[][],
  insertCalls: [] as InsertCall[],
  insertReturning: new Map<string, unknown[]>(),
  updateCalls: [] as UpdateCall[],
  executeQueue: [] as Array<{ rows: unknown[] }>,
  reset() {
    this.selectQueue = [];
    this.insertCalls = [];
    this.insertReturning.clear();
    this.updateCalls = [];
    this.executeQueue = [];
  },
};

function tableName(t: unknown): string {
  return (t as { __name?: string })?.__name || "unknown";
}

vi.mock("@workspace/db", () => {
  const tables = {
    tenantsTable: { __name: "tenants", id: "tenants.id" },
    campaignsTable: { __name: "campaigns", tenantId: "c.tenantId", platform: "c.platform", externalId: "c.externalId", id: "c.id" },
    campaignDailyStatsTable: { __name: "campaign_daily_stats", campaignId: "cds.campaignId", date: "cds.date" },
    integrationSyncLogsTable: { __name: "integration_sync_logs", id: "isl.id" },
    metaAdDailyStatsTable: { __name: "meta_ad_daily_stats", tenantId: "mads.tenantId", adExternalId: "mads.adExternalId", date: "mads.date" },
    metaAdAccountsTable: { __name: "meta_ad_accounts", tenantId: "maa.tenantId", accountId: "maa.accountId" },
    metaAdsTable: { __name: "meta_ads" },
    metaAdSetsTable: { __name: "meta_ad_sets" },
    jobsTable: { __name: "jobs" },
    leadsTable: { __name: "leads" },
    soldEstimatesTable: { __name: "sold_estimates" },
    callAttemptsTable: { __name: "call_attempts" },
  };

  function makeSelectChain(): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    const resolveResult = () => {
      const next = state.selectQueue.length ? state.selectQueue.shift() : [];
      return Promise.resolve(next);
    };
    chain.from = vi.fn().mockReturnValue(chain);
    chain.where = vi.fn().mockReturnValue({
      limit: vi.fn().mockImplementation(resolveResult),
      then: (r: Function) => resolveResult().then(r as (v: unknown) => unknown),
    });
    chain.limit = vi.fn().mockImplementation(resolveResult);
    chain.then = (r: Function) => resolveResult().then(r as (v: unknown) => unknown);
    return chain;
  }

  const db = {
    select: vi.fn().mockImplementation(() => makeSelectChain()),
    insert: vi.fn().mockImplementation((table: unknown) => {
      const name = tableName(table);
      return {
        values: vi.fn().mockImplementation((vals: unknown) => {
          const valsArr = Array.isArray(vals) ? vals : [vals];
          const baseCall: InsertCall = { table: name, values: valsArr };
          state.insertCalls.push(baseCall);
          const returningRows = state.insertReturning.get(name) || [];
          const ret = {
            returning: vi.fn().mockResolvedValue(returningRows),
            then: (r: Function) => Promise.resolve(undefined).then(r as (v: unknown) => unknown),
          };
          return Object.assign(ret, {
            onConflictDoUpdate: vi.fn().mockImplementation(() => {
              baseCall.onConflict = "update";
              return ret;
            }),
            onConflictDoNothing: vi.fn().mockImplementation(() => {
              baseCall.onConflict = "nothing";
              return ret;
            }),
          });
        }),
      };
    }),
    update: vi.fn().mockImplementation((table: unknown) => {
      const name = tableName(table);
      return {
        set: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
          state.updateCalls.push({ table: name, set: vals });
          return { where: vi.fn().mockResolvedValue(undefined) };
        }),
      };
    }),
    execute: vi.fn().mockImplementation(() => {
      const next = state.executeQueue.length ? state.executeQueue.shift()! : { rows: [] };
      return Promise.resolve(next);
    }),
  };

  return { db, ...tables };
});

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...args: unknown[]) => ({ __op: "eq", args })),
  and: vi.fn((...args: unknown[]) => ({ __op: "and", args })),
  or: vi.fn((...args: unknown[]) => ({ __op: "or", args })),
  isNull: vi.fn((a: unknown) => ({ __op: "isNull", a })),
  isNotNull: vi.fn((a: unknown) => ({ __op: "isNotNull", a })),
  desc: vi.fn((a: unknown) => ({ __op: "desc", a })),
  sql: Object.assign(
    (strings: TemplateStringsArray, ..._values: unknown[]) => ({ __sql: strings.join("?") }),
    {},
  ),
}));

vi.mock("../middleware/auth", () => ({
  requireRole: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

// Stub heavyweight peers the sync-scheduler imports but we don't exercise here.
vi.mock("../services/notifications", () => ({ emitSyncFailureNotification: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../services/reconciliation", () => ({ runReconciliation: vi.fn() }));
vi.mock("../services/integrations/service-titan", () => ({
  fetchCompletedJobs: vi.fn(), formatSTJobForSync: vi.fn(),
  fetchCustomerContactsById: vi.fn(), fetchLocationsByIds: vi.fn(),
  formatLocationAddress: vi.fn(), fetchInvoices: vi.fn(),
  parseInvoiceData: vi.fn(), fetchSoldEstimates: vi.fn(),
  parseEstimateData: vi.fn(), resolveEmployeeName: vi.fn(), clearEmployeeCache: vi.fn(),
}));
vi.mock("../services/integrations/google-ads", () => ({ fetchCampaignPerformance: vi.fn(), formatCampaignRow: vi.fn() }));
vi.mock("../services/integrations/podium", () => ({ syncPodiumReviews: vi.fn() }));

// Mock MetaAPIService — expose configurable spies. The backfill route now
// drives its insights pulls through `fetchAdDailyInsightsAsync` (Task #561,
// Meta's async report path), but we keep a `fetchAdDailyInsights` mock too
// in case other code paths reach for it.
const metaMocks = vi.hoisted(() => ({
  fetchAdDailyInsights: (..._args: unknown[]) => Promise.resolve([]) as Promise<unknown>,
  fetchAdDailyInsightsAsync: (..._args: unknown[]) => Promise.resolve([]) as Promise<unknown>,
  fetchAdSets: (..._args: unknown[]) => Promise.resolve([]) as Promise<unknown>,
  fetchAds: (..._args: unknown[]) => Promise.resolve([]) as Promise<unknown>,
  listAdAccounts: (..._args: unknown[]) => Promise.resolve([]) as Promise<unknown>,
  verifyToken: (..._args: unknown[]) => Promise.resolve({}) as Promise<unknown>,
  requestCount: 0,
}));

vi.mock("../services/integrations/meta", async () => {
  const actual = await vi.importActual<typeof import("../services/integrations/meta")>(
    "../services/integrations/meta",
  );
  class MockMetaAPIService {
    fetchAdDailyInsights(...args: unknown[]) { return metaMocks.fetchAdDailyInsights(...args); }
    fetchAdDailyInsightsAsync(...args: unknown[]) { return metaMocks.fetchAdDailyInsightsAsync(...args); }
    fetchAdSets(...args: unknown[]) { return metaMocks.fetchAdSets(...args); }
    fetchAds(...args: unknown[]) { return metaMocks.fetchAds(...args); }
    listAdAccounts(...args: unknown[]) { return metaMocks.listAdAccounts(...args); }
    verifyToken(...args: unknown[]) { return metaMocks.verifyToken(...args); }
    get requestCount() { return metaMocks.requestCount; }
  }
  return { ...actual, MetaAPIService: MockMetaAPIService };
});

// The backfill route uses Meta's async report path. Tests assert calls
// against `fetchAdDailyInsightsAsync`; the old variable name is kept as an
// alias so test bodies read the same.
const fetchAdDailyInsightsMock = vi.fn();

beforeEach(() => {
  metaMocks.fetchAdDailyInsightsAsync = fetchAdDailyInsightsMock as unknown as typeof metaMocks.fetchAdDailyInsightsAsync;
});

// ─── Test app + helpers ──────────────────────────────────────────────────────

let app: express.Express;

async function setupApp() {
  vi.resetModules();
  const mod = await import("./meta-accounts");
  app = express();
  app.use(express.json());
  app.use(mod.default);
}

interface Resp { status: number; body: Record<string, unknown> }

function postJson(path: string, body: Record<string, unknown> = {}): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      const payload = JSON.stringify(body);
      const req = http.request(
        {
          hostname: "127.0.0.1", port, path, method: "POST",
          headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            server.close();
            const text = Buffer.concat(chunks).toString("utf8");
            let parsed: Record<string, unknown> = {};
            try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
            resolve({ status: res.statusCode || 0, body: parsed });
          });
        },
      );
      req.on("error", reject);
      req.write(payload);
      req.end();
    });
  });
}

function tenantWithMeta(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 7,
    name: "Acme",
    apiConfig: encryptConfig({
      metaAccessToken: "tok-abc",
      metaAdAccountId: "act_999",
    }),
    metaNeedsReconnect: false,
    metaReconnectReason: null,
    ...overrides,
  };
}

beforeEach(async () => {
  state.reset();
  fetchAdDailyInsightsMock.mockReset();
  // Sync log insert returns a row with id=1.
  state.insertReturning.set("integration_sync_logs", [{ id: 1 }]);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  await setupApp();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("POST /integrations/meta/backfill — days validation", () => {
  it("rejects days <= 30 with 400 (nightly sync already covers that window)", async () => {
    const res = await postJson("/integrations/meta/backfill", { tenantId: 7, days: 30 });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/days must be a number > 30/);
    // Should short-circuit before any sync log is written.
    expect(state.insertCalls.find((c) => c.table === "integration_sync_logs")).toBeUndefined();
    expect(fetchAdDailyInsightsMock).not.toHaveBeenCalled();
  });

  it("rejects days > 1095 with 400 (Meta retention cap)", async () => {
    const res = await postJson("/integrations/meta/backfill", { tenantId: 7, days: 1096 });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/cannot exceed 1095/);
    expect(state.insertCalls.find((c) => c.table === "integration_sync_logs")).toBeUndefined();
    expect(fetchAdDailyInsightsMock).not.toHaveBeenCalled();
  });

  it("rejects missing tenantId with 400", async () => {
    const res = await postJson("/integrations/meta/backfill", { days: 60 });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/tenantId required/);
  });
});

describe("POST /integrations/meta/backfill — early exits", () => {
  it("returns 400 when tenant has no Meta config", async () => {
    state.selectQueue.push([{ id: 7, apiConfig: null, metaNeedsReconnect: false, metaReconnectReason: null }]);
    const res = await postJson("/integrations/meta/backfill", { tenantId: 7, days: 60 });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/Meta not configured/);
    expect(fetchAdDailyInsightsMock).not.toHaveBeenCalled();

    // A backfill sync log is opened and immediately closed as error.
    const inserted = state.insertCalls.find((c) => c.table === "integration_sync_logs");
    expect(inserted).toBeDefined();
    expect((inserted!.values[0] as Record<string, unknown>).syncType).toBe("backfill");
    const errLog = state.updateCalls.find(
      (u) => u.table === "integration_sync_logs" && u.set.status === "error",
    );
    expect(errLog).toBeDefined();
    expect(String(errLog!.set.errorMessage)).toMatch(/Meta not configured/);
  });

  it("returns 400 when tenant is flagged metaNeedsReconnect", async () => {
    state.selectQueue.push([
      tenantWithMeta({ metaNeedsReconnect: true, metaReconnectReason: "token expired" }),
    ]);
    const res = await postJson("/integrations/meta/backfill", { tenantId: 7, days: 60 });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/Meta needs reconnect/);
    expect(fetchAdDailyInsightsMock).not.toHaveBeenCalled();

    const errLog = state.updateCalls.find(
      (u) => u.table === "integration_sync_logs" && u.set.status === "error",
    );
    expect(errLog).toBeDefined();
    expect(String(errLog!.set.errorMessage)).toMatch(/Meta needs reconnect/);
  });

  it("returns 409 when the per-tenant Meta advisory lock is already held", async () => {
    state.selectQueue.push([tenantWithMeta()]);
    // Currency lookup (called after lock acquired in source) — won't run, but
    // queue stays empty either way. Lock contention short-circuits.
    state.executeQueue.push({ rows: [{ got: false }] });

    const res = await postJson("/integrations/meta/backfill", { tenantId: 7, days: 60 });
    expect(res.status).toBe(409);
    expect(String(res.body.error)).toMatch(/already running/i);
    expect(fetchAdDailyInsightsMock).not.toHaveBeenCalled();

    // The opened sync log was finalized as error.
    const errLog = state.updateCalls.find(
      (u) => u.table === "integration_sync_logs" && u.set.status === "error",
    );
    expect(errLog).toBeDefined();
  });
});

describe("POST /integrations/meta/backfill — expired token mid-run", () => {
  it("flags tenant for reconnect, finalizes sync log as error, and returns 502 when fetchAdDailyInsights throws MetaTokenInvalidError partway through", async () => {
    const { MetaTokenInvalidError } = await import("../services/integrations/meta");

    // Same select-ordering as the success test:
    //   1. tenants
    //   2. meta_ad_accounts (currency lookup)
    //   3. campaigns lookup for the first chunk's row (will INSERT)
    state.selectQueue.push([tenantWithMeta()]);
    state.selectQueue.push([{ accountId: "999", currency: "USD" }]);
    state.selectQueue.push([]);

    // Advisory lock acquired.
    state.executeQueue.push({ rows: [{ got: true }] });

    // Insert into campaigns returns the new campaign id used by the rollup.
    state.insertReturning.set("campaigns", [{ id: 100 }]);

    // 31-day window → 2 chunks. First chunk delivers data, second blows up
    // with an expired-token error halfway through the run.
    fetchAdDailyInsightsMock.mockResolvedValueOnce([
      {
        ad_id: "ad_1", ad_name: "Ad 1", adset_id: "as_1",
        campaign_id: "c1", campaign_name: "Campaign One",
        date_start: "2025-06-01", date_stop: "2025-06-01",
        spend: "1.00", impressions: "10", clicks: "1",
        actions: [{ action_type: "lead", value: "1" }],
      },
    ]);
    const tokenErr = new MetaTokenInvalidError(
      "Meta access token expired (OAuthException 190/463)",
      190,
      463,
    );
    fetchAdDailyInsightsMock.mockRejectedValueOnce(tokenErr);

    const res = await postJson("/integrations/meta/backfill", { tenantId: 7, days: 31 });

    // Route maps backfill errors that aren't 'already running'/'not found'/
    // 'not configured|needs reconnect' to 502.
    expect(res.status).toBe(502);
    expect(res.body.success).toBe(false);
    expect(String(res.body.error)).toMatch(/access token expired/i);

    // Tenant row was flipped so the UI shows a reconnect prompt.
    const tenantUpdate = state.updateCalls.find(
      (u) => u.table === "tenants" && u.set.metaNeedsReconnect === true,
    );
    expect(tenantUpdate).toBeDefined();
    expect(tenantUpdate!.set.metaNeedsReconnect).toBe(true);
    expect(String(tenantUpdate!.set.metaReconnectReason)).toMatch(/access token expired/i);

    // The sync log opened with sync_type='backfill' was finalized as 'error'
    // carrying the token message.
    const opened = state.insertCalls.find((c) => c.table === "integration_sync_logs");
    expect(opened).toBeDefined();
    expect((opened!.values[0] as Record<string, unknown>).syncType).toBe("backfill");

    const errLog = state.updateCalls.find(
      (u) => u.table === "integration_sync_logs" && u.set.status === "error",
    );
    expect(errLog).toBeDefined();
    expect(String(errLog!.set.errorMessage)).toMatch(/access token expired/i);

    // Second chunk was actually attempted (so the catch ran on a real call).
    expect(fetchAdDailyInsightsMock).toHaveBeenCalledTimes(2);
  });
});

describe("POST /integrations/meta/backfill — successful run", () => {
  it("writes meta_ad_daily_stats + campaign_daily_stats and a 'completed' backfill sync log", async () => {
    // Order of db.select() calls inside backfillMetaCampaigns:
    //   1. tenants
    //   2. meta_ad_accounts (currency lookup)
    //   3+. campaigns lookup per distinct campaign id (per chunk that has data)
    state.selectQueue.push([tenantWithMeta()]);
    state.selectQueue.push([{ accountId: "999", currency: "USD" }]);
    // Campaign "c1" not yet in db — will INSERT and use insertReturning.
    state.selectQueue.push([]);

    // Advisory lock acquired.
    state.executeQueue.push({ rows: [{ got: true }] });

    // Insert into campaigns returns the new campaign id used by the rollup.
    state.insertReturning.set("campaigns", [{ id: 100 }]);

    // 31-day window → 2 chunks. Only the first chunk has insights; the second
    // is empty so the upsert path is a no-op for it.
    fetchAdDailyInsightsMock.mockResolvedValueOnce([
      {
        ad_id: "ad_1", ad_name: "Ad 1", adset_id: "as_1",
        campaign_id: "c1", campaign_name: "Campaign One",
        date_start: "2025-06-01", date_stop: "2025-06-01",
        spend: "9.99", impressions: "500", clicks: "20",
        actions: [{ action_type: "lead", value: "3" }],
      },
    ]);
    fetchAdDailyInsightsMock.mockResolvedValue([]);

    const res = await postJson("/integrations/meta/backfill", { tenantId: 7, days: 31 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.synced).toBe(1);
    expect(typeof res.body.chunks).toBe("number");
    expect(res.body.chunks as number).toBeGreaterThanOrEqual(2);

    // The Meta API was invoked once per chunk with (since, until) date strings.
    expect(fetchAdDailyInsightsMock).toHaveBeenCalledTimes(res.body.chunks as number);
    for (const call of fetchAdDailyInsightsMock.mock.calls) {
      expect(typeof call[0]).toBe("string");
      expect(typeof call[1]).toBe("string");
      expect(call[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(call[1]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }

    // Per-ad daily stats upserted via ON CONFLICT.
    const adDaily = state.insertCalls.find((c) => c.table === "meta_ad_daily_stats");
    expect(adDaily).toBeDefined();
    expect(adDaily!.onConflict).toBe("update");
    const row = adDaily!.values[0] as Record<string, unknown>;
    expect(row.tenantId).toBe(7);
    expect(row.adExternalId).toBe("ad_1");
    expect(row.spend).toBe(9.99);
    expect(row.impressions).toBe(500);
    expect(row.clicks).toBe(20);
    expect(row.conversions).toBe(3);

    // Campaign-day rollups upserted via ON CONFLICT.
    const cds = state.insertCalls.find((c) => c.table === "campaign_daily_stats");
    expect(cds).toBeDefined();
    expect(cds!.onConflict).toBe("update");

    // The sync log was opened with sync_type='backfill' and finalized as completed.
    const opened = state.insertCalls.find((c) => c.table === "integration_sync_logs");
    expect(opened).toBeDefined();
    const openedRow = opened!.values[0] as Record<string, unknown>;
    expect(openedRow.integration).toBe("meta");
    expect(openedRow.syncType).toBe("backfill");
    expect(openedRow.status).toBe("running");

    const completed = state.updateCalls.find(
      (u) => u.table === "integration_sync_logs" && u.set.status === "completed",
    );
    expect(completed).toBeDefined();
    expect(completed!.set.recordsProcessed).toBe(1);
    expect(completed!.set.errorMessage).toBeNull();
  });
});

describe("POST /integrations/meta/backfill — cooperative cancel", () => {
  it("finalizes the sync log as 'cancelled' (not error) at a chunk boundary, preserving rows already saved", async () => {
    // Chunk 0 saves one ad-day row; at the chunk-1 boundary the cancel flag is
    // set, so the run unwinds cleanly. The chunk-boundary checkCancel reads the
    // cancelRequested flag off the sync log row.
    //
    // db.select() order inside backfillMetaCampaigns:
    //   1. tenants
    //   2. meta_ad_accounts (currency lookup)
    //   3. checkCancel @ chunk 0 boundary → not cancelled
    //   4. campaigns lookup (chunk 0 row) → insert
    //   5. checkCancel @ chunk 1 boundary → cancelled → break
    state.selectQueue.push([tenantWithMeta()]);
    state.selectQueue.push([{ accountId: "999", currency: "USD" }]);
    state.selectQueue.push([{ cancel: false }]); // chunk 0 boundary: keep going
    state.selectQueue.push([]); // campaigns lookup → not found → insert
    state.selectQueue.push([{ cancel: true }]); // chunk 1 boundary: cancel!

    state.executeQueue.push({ rows: [{ got: true }] });
    state.insertReturning.set("campaigns", [{ id: 100 }]);

    // 31-day window → 2 chunks. Chunk 0 returns one row; chunk 1 is never
    // fetched because we break at its boundary.
    fetchAdDailyInsightsMock.mockResolvedValueOnce([
      {
        ad_id: "ad_1", ad_name: "Ad 1", adset_id: "as_1",
        campaign_id: "c1", campaign_name: "Campaign One",
        date_start: "2025-06-01", date_stop: "2025-06-01",
        spend: "1.00", impressions: "10", clicks: "1",
        actions: [{ action_type: "lead", value: "1" }],
      },
    ]);
    fetchAdDailyInsightsMock.mockResolvedValue([]);

    const res = await postJson("/integrations/meta/backfill", { tenantId: 7, days: 31 });

    // A deliberate cancel resolves as a 200 success with cancelled:true, not a
    // 502 failure.
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.cancelled).toBe(true);
    expect(res.body.synced).toBe(1);

    // Only chunk 0 was fetched — we broke at the chunk-1 boundary.
    expect(fetchAdDailyInsightsMock).toHaveBeenCalledTimes(1);

    // The sync log was finalized as 'cancelled' (not 'error'), keeping the one
    // row already synced.
    const cancelledLog = state.updateCalls.find(
      (u) => u.table === "integration_sync_logs" && u.set.status === "cancelled",
    );
    expect(cancelledLog).toBeDefined();
    expect(cancelledLog!.set.recordsProcessed).toBe(1);
    expect(String(cancelledLog!.set.errorMessage)).toMatch(/cancelled by operator/i);

    // No 'error' status was ever written.
    expect(
      state.updateCalls.find((u) => u.table === "integration_sync_logs" && u.set.status === "error"),
    ).toBeUndefined();
  });

  it("cancels before any work when the flag is already set at the first chunk boundary (zero rows synced)", async () => {
    state.selectQueue.push([tenantWithMeta()]);
    state.selectQueue.push([{ accountId: "999", currency: "USD" }]);
    state.selectQueue.push([{ cancel: true }]); // chunk 0 boundary: cancel immediately

    state.executeQueue.push({ rows: [{ got: true }] });

    const res = await postJson("/integrations/meta/backfill", { tenantId: 7, days: 31 });

    expect(res.status).toBe(200);
    expect(res.body.cancelled).toBe(true);
    expect(res.body.synced).toBe(0);

    // Nothing was fetched — we cancelled before the first chunk's report pull.
    expect(fetchAdDailyInsightsMock).not.toHaveBeenCalled();

    const cancelledLog = state.updateCalls.find(
      (u) => u.table === "integration_sync_logs" && u.set.status === "cancelled",
    );
    expect(cancelledLog).toBeDefined();
    expect(cancelledLog!.set.recordsProcessed).toBe(0);
  });

  it("stops mid-chunk within a few seconds via the dedicated cancel poll fired from the async-report heartbeat", async () => {
    // A single chunk spends minutes inside the async report poll. The cancel
    // poll now rides the report-poll heartbeat callback on its own ~3s cadence
    // (CANCEL_POLL_MIN_INTERVAL_MS), decoupled from the ~30s heartbeat flush
    // (HEARTBEAT_MIN_INTERVAL_MS). We advance a mocked clock by 5s before
    // firing the poll heartbeat: that's past the 3s cancel cadence but well
    // under the 30s flush cadence, so the cancel poll fires and unwinds the run
    // before the chunk's upsert is ever reached.
    let mockNow = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => mockNow);

    // db.select() order:
    //   1. tenants
    //   2. meta_ad_accounts (currency lookup)
    //   3. checkCancel @ chunk 0 boundary → not cancelled
    //   4. cancel poll fired from onPollHeartbeat → cancelled → throw
    state.selectQueue.push([tenantWithMeta()]);
    state.selectQueue.push([{ accountId: "999", currency: "USD" }]);
    state.selectQueue.push([{ cancel: false }]); // chunk 0 boundary: keep going
    state.selectQueue.push([{ cancel: true }]); // cancel poll inside report heartbeat

    state.executeQueue.push({ rows: [{ got: true }] });

    // The async report mock advances the clock past the 3s cancel cadence, then
    // fires the poll heartbeat. The cancel poll riding that callback throws to
    // unwind — so the mock never returns rows and the upsert is never reached.
    fetchAdDailyInsightsMock.mockImplementation(
      async (_since: string, _until: string, opts: {
        onPollHeartbeat?: (info: { percentComplete: number; status: string }) => Promise<void> | void;
      }) => {
        mockNow += 5_000;
        if (opts?.onPollHeartbeat) {
          await opts.onPollHeartbeat({ percentComplete: 50, status: "JOB_RUNNING" });
        }
        return [];
      },
    );

    const res = await postJson("/integrations/meta/backfill", { tenantId: 7, days: 31 });

    expect(res.status).toBe(200);
    expect(res.body.cancelled).toBe(true);
    // The cancel poll fired during report generation, before any rows were
    // upserted. (The old code had no cancel path at all, so the run would have
    // pushed on through every chunk.)
    expect(res.body.synced).toBe(0);

    const cancelledLog = state.updateCalls.find(
      (u) => u.table === "integration_sync_logs" && u.set.status === "cancelled",
    );
    expect(cancelledLog).toBeDefined();
    expect(cancelledLog!.set.recordsProcessed).toBe(0);

    // No 'error' status was written — the cancel is the expected unwind path.
    expect(
      state.updateCalls.find((u) => u.table === "integration_sync_logs" && u.set.status === "error"),
    ).toBeUndefined();
  });
});
