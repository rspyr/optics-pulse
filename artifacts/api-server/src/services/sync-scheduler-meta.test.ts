import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { encryptConfig } from "../lib/encryption";
import { MetaTokenInvalidError, MetaApiError } from "./integrations/meta";

// ─── Mock state ──────────────────────────────────────────────────────────────

interface InsertCall { table: string; values: unknown[]; onConflict?: "update" | "nothing" }
interface UpdateCall { table: string; set: Record<string, unknown> }

const state = {
  tenants: [] as Array<Record<string, unknown>>,
  selectQueue: [] as unknown[][],
  insertCalls: [] as InsertCall[],
  insertReturning: new Map<string, unknown[]>(),
  updateCalls: [] as UpdateCall[],
  executeQueue: [] as Array<{ rows: unknown[] }>,
  reset() {
    this.tenants = [];
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
    jobsTable: { __name: "jobs" },
    leadsTable: { __name: "leads" },
    campaignsTable: { __name: "campaigns", tenantId: "c.tenantId", platform: "c.platform", externalId: "c.externalId", id: "c.id" },
    campaignDailyStatsTable: { __name: "campaign_daily_stats", campaignId: "cds.campaignId", date: "cds.date" },
    integrationSyncLogsTable: { __name: "integration_sync_logs", id: "isl.id" },
    soldEstimatesTable: { __name: "sold_estimates" },
    callAttemptsTable: { __name: "call_attempts" },
    metaAdsTable: { __name: "meta_ads", tenantId: "ma.tenantId", externalId: "ma.externalId" },
    metaAdSetsTable: { __name: "meta_ad_sets", tenantId: "mas.tenantId", externalId: "mas.externalId" },
    metaAdDailyStatsTable: { __name: "meta_ad_daily_stats", tenantId: "mads.tenantId", adExternalId: "mads.adExternalId", date: "mads.date" },
    metaAdAccountsTable: { __name: "meta_ad_accounts", tenantId: "maa.tenantId", accountId: "maa.accountId" },
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
      const next = state.executeQueue.length
        ? state.executeQueue.shift()!
        : { rows: [] };
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

// Stub heavyweight peers we don't exercise here.
vi.mock("./notifications", () => ({ emitSyncFailureNotification: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./reconciliation", () => ({ runReconciliation: vi.fn() }));
vi.mock("./integrations/service-titan", () => ({
  fetchCompletedJobs: vi.fn(), formatSTJobForSync: vi.fn(),
  fetchCustomerContactsById: vi.fn(), fetchLocationsByIds: vi.fn(),
  formatLocationAddress: vi.fn(), fetchInvoices: vi.fn(),
  parseInvoiceData: vi.fn(), fetchSoldEstimates: vi.fn(),
  parseEstimateData: vi.fn(), resolveEmployeeName: vi.fn(), clearEmployeeCache: vi.fn(),
}));
vi.mock("./integrations/google-ads", () => ({ fetchCampaignPerformance: vi.fn(), formatCampaignRow: vi.fn() }));
vi.mock("./integrations/podium", () => ({ syncPodiumReviews: vi.fn() }));

// Mock MetaAPIService — we test the API service separately.
// Use vi.hoisted so the spies are available inside the hoisted vi.mock factory.
const metaMocks = vi.hoisted(() => ({
  fetchAdSets: (..._args: unknown[]) => Promise.resolve([]) as Promise<unknown>,
  fetchAds: (..._args: unknown[]) => Promise.resolve([]) as Promise<unknown>,
  fetchAdDailyInsights: (..._args: unknown[]) => Promise.resolve([]) as Promise<unknown>,
}));

vi.mock("./integrations/meta", async () => {
  const actual = await vi.importActual<typeof import("./integrations/meta")>("./integrations/meta");
  class MockMetaAPIService {
    fetchAdSets(...args: unknown[]) { return metaMocks.fetchAdSets(...args); }
    fetchAds(...args: unknown[]) { return metaMocks.fetchAds(...args); }
    fetchAdDailyInsights(...args: unknown[]) { return metaMocks.fetchAdDailyInsights(...args); }
  }
  return { ...actual, MetaAPIService: MockMetaAPIService };
});

const fetchAdSetsMock = vi.fn();
const fetchAdsMock = vi.fn();
const fetchAdDailyInsightsMock = vi.fn();

beforeEach(() => {
  metaMocks.fetchAdSets = fetchAdSetsMock as unknown as typeof metaMocks.fetchAdSets;
  metaMocks.fetchAds = fetchAdsMock as unknown as typeof metaMocks.fetchAds;
  metaMocks.fetchAdDailyInsights = fetchAdDailyInsightsMock as unknown as typeof metaMocks.fetchAdDailyInsights;
});

// ─── Test helpers ────────────────────────────────────────────────────────────

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

beforeEach(() => {
  state.reset();
  fetchAdSetsMock.mockReset();
  fetchAdsMock.mockReset();
  fetchAdDailyInsightsMock.mockReset();
  // Default: insert into integration_sync_logs returns a row with id=1
  state.insertReturning.set("integration_sync_logs", [{ id: 1 }]);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("syncMetaCampaigns — happy path", () => {
  it("upserts ad sets, ads, per-ad daily stats, and campaign rollups using ON CONFLICT", async () => {
    const { syncMetaCampaigns } = await import("./sync-scheduler");

    // db.select() calls in order:
    //   1. tenants (load tenant)
    //   2. integration_sync_logs.insert -> returning (handled by insertReturning)
    //   3. execute(advisory lock)
    //   4. select meta_ad_accounts (currency lookup)
    //   5+. campaigns lookup per distinct campaign id
    state.selectQueue.push([tenantWithMeta()]);
    state.selectQueue.push([{ accountId: "999", currency: "USD" }]);
    // campaigns lookup for campaign "c1" -> not found, will INSERT and use insertReturning
    state.selectQueue.push([]);
    state.selectQueue.push([]); // campaign c2 lookup
    state.executeQueue.push({ rows: [{ got: true }] });

    // campaigns insert returning
    state.insertReturning.set("campaigns", [{ id: 100 }]);

    fetchAdSetsMock.mockResolvedValue([
      { id: "as_1", name: "Set 1", campaign_id: "c1", effective_status: "ACTIVE", daily_budget: "1000" },
    ]);
    fetchAdsMock.mockResolvedValue([
      { id: "ad_1", name: "Ad 1", adset_id: "as_1", campaign_id: "c1", effective_status: "ACTIVE", creative: { id: "cr_1" } },
      { id: "ad_2", name: "Ad 2", adset_id: "as_1", campaign_id: "c2", effective_status: "PAUSED" },
    ]);
    fetchAdDailyInsightsMock.mockResolvedValue([
      {
        ad_id: "ad_1", ad_name: "Ad 1", adset_id: "as_1",
        campaign_id: "c1", campaign_name: "Campaign One",
        date_start: "2026-05-10", date_stop: "2026-05-10",
        spend: "12.50", impressions: "1000", clicks: "30",
        actions: [{ action_type: "lead", value: "4" }, { action_type: "purchase", value: "2" }],
      },
      {
        ad_id: "ad_2", ad_name: "Ad 2", adset_id: "as_1",
        campaign_id: "c2", campaign_name: "Campaign Two",
        date_start: "2026-05-10", date_stop: "2026-05-10",
        spend: "5", impressions: "200", clicks: "10",
        actions: [],
      },
    ]);

    const result = await syncMetaCampaigns(7);

    expect(result.error).toBeUndefined();
    expect(result.synced).toBe(2);

    // Ad-set upsert was a single batched ON CONFLICT statement.
    const adSetInserts = state.insertCalls.filter((c) => c.table === "meta_ad_sets");
    expect(adSetInserts).toHaveLength(1);
    expect(adSetInserts[0].onConflict).toBe("update");
    expect(adSetInserts[0].values).toHaveLength(1);

    // Ads upsert was batched ON CONFLICT.
    const adInserts = state.insertCalls.filter((c) => c.table === "meta_ads");
    expect(adInserts).toHaveLength(1);
    expect(adInserts[0].onConflict).toBe("update");
    expect(adInserts[0].values).toHaveLength(2);

    // Per-ad daily stats batched ON CONFLICT (single chunk for 2 rows).
    const adDailyInserts = state.insertCalls.filter((c) => c.table === "meta_ad_daily_stats");
    expect(adDailyInserts).toHaveLength(1);
    expect(adDailyInserts[0].onConflict).toBe("update");
    expect(adDailyInserts[0].values).toHaveLength(2);
    const firstRow = adDailyInserts[0].values[0] as Record<string, unknown>;
    expect(firstRow.adExternalId).toBe("ad_1");
    expect(firstRow.spend).toBe(12.5);
    expect(firstRow.impressions).toBe(1000);
    expect(firstRow.clicks).toBe(30);
    // Conversions = lead(4) + purchase(2) = 6
    expect(firstRow.conversions).toBe(6);

    // Campaign-day rollups batched ON CONFLICT.
    const cdsInserts = state.insertCalls.filter((c) => c.table === "campaign_daily_stats");
    expect(cdsInserts).toHaveLength(1);
    expect(cdsInserts[0].onConflict).toBe("update");

    // Tenant updated to clear reconnect flag and bump metaLastSyncedAt.
    const tenantUpdate = state.updateCalls.find((u) => u.table === "tenants" && "metaLastSyncedAt" in u.set);
    expect(tenantUpdate?.set.metaNeedsReconnect).toBe(false);
    expect(tenantUpdate?.set.metaReconnectReason).toBeNull();

    // Sync log was finalized as completed.
    const completedLog = state.updateCalls.find(
      (u) => u.table === "integration_sync_logs" && u.set.status === "completed",
    );
    expect(completedLog).toBeDefined();
    expect(completedLog!.set.recordsProcessed).toBe(2);
  });
});

describe("syncMetaCampaigns — advisory lock", () => {
  it("returns an error and does NOT call the Meta API when another sync holds the lock", async () => {
    const { syncMetaCampaigns } = await import("./sync-scheduler");

    state.selectQueue.push([tenantWithMeta()]);
    // Advisory lock contention
    state.executeQueue.push({ rows: [{ got: false }] });

    const result = await syncMetaCampaigns(7);

    expect(result.synced).toBe(0);
    expect(result.error).toMatch(/Another Meta sync is already running/);
    expect(fetchAdSetsMock).not.toHaveBeenCalled();
    expect(fetchAdsMock).not.toHaveBeenCalled();
    expect(fetchAdDailyInsightsMock).not.toHaveBeenCalled();

    // Sync log finalized as error.
    const errLog = state.updateCalls.find(
      (u) => u.table === "integration_sync_logs" && u.set.status === "error",
    );
    expect(errLog).toBeDefined();
  });
});

describe("syncMetaCampaigns — token expired", () => {
  it("flags metaNeedsReconnect when MetaTokenInvalidError is thrown during sync", async () => {
    const { syncMetaCampaigns } = await import("./sync-scheduler");

    state.selectQueue.push([tenantWithMeta()]);
    state.selectQueue.push([{ accountId: "999", currency: "USD" }]);
    state.executeQueue.push({ rows: [{ got: true }] });

    const tokenErr = new MetaTokenInvalidError("Session has expired", 190, 463);
    fetchAdSetsMock.mockRejectedValue(tokenErr);
    fetchAdsMock.mockResolvedValue([]);
    fetchAdDailyInsightsMock.mockResolvedValue([]);

    const result = await syncMetaCampaigns(7);

    expect(result.synced).toBe(0);
    expect(result.error).toMatch(/Session has expired/);

    // Tenant flagged for reconnect.
    const reconnectUpdate = state.updateCalls.find(
      (u) => u.table === "tenants" && u.set.metaNeedsReconnect === true,
    );
    expect(reconnectUpdate).toBeDefined();
    expect(reconnectUpdate!.set.metaReconnectReason).toMatch(/Session has expired/);

    // Sync log finalized as error with the token message.
    const errLog = state.updateCalls.find(
      (u) => u.table === "integration_sync_logs" && u.set.status === "error",
    );
    expect(errLog).toBeDefined();
    expect(errLog!.set.errorMessage).toMatch(/Session has expired/);
  });

  it("does NOT flag metaNeedsReconnect on a Meta rate-limit error (code 17) and writes error_code='rate_limit'", async () => {
    const { syncMetaCampaigns } = await import("./sync-scheduler");

    state.selectQueue.push([tenantWithMeta()]);
    state.selectQueue.push([{ accountId: "999", currency: "USD" }]);
    state.executeQueue.push({ rows: [{ got: true }] });

    // Simulate the meta service exhausting retries on a code-17 rate limit:
    // the request() loop throws a transient MetaApiError after MAX_RETRIES,
    // NOT a MetaTokenInvalidError. The sync-scheduler catch must therefore
    // skip the reconnect-flagging branch.
    const rateErr = new MetaApiError(
      "(#17) User request limit reached",
      400,
      17,
      true,
    );
    fetchAdSetsMock.mockRejectedValue(rateErr);
    fetchAdsMock.mockResolvedValue([]);
    fetchAdDailyInsightsMock.mockResolvedValue([]);

    const result = await syncMetaCampaigns(7);

    expect(result.synced).toBe(0);
    expect(result.error).toMatch(/User request limit reached/);

    // Critically: the tenant must NOT be flagged for reconnect.
    const reconnectUpdate = state.updateCalls.find(
      (u) => u.table === "tenants" && u.set.metaNeedsReconnect === true,
    );
    expect(reconnectUpdate).toBeUndefined();

    // Sync log finalized as error with a stable `rate_limit` code so the
    // Settings panel renders the right copy.
    const errLog = state.updateCalls.find(
      (u) => u.table === "integration_sync_logs" && u.set.status === "error",
    );
    expect(errLog).toBeDefined();
    expect(errLog!.set.errorMessage).toMatch(/User request limit reached/);
    expect(errLog!.set.errorCode).toBe("rate_limit");
  });

  it("short-circuits with an error sync log when tenant is already flagged metaNeedsReconnect", async () => {
    const { syncMetaCampaigns } = await import("./sync-scheduler");

    state.selectQueue.push([
      tenantWithMeta({ metaNeedsReconnect: true, metaReconnectReason: "expired earlier" }),
    ]);

    const result = await syncMetaCampaigns(7);

    expect(result.synced).toBe(0);
    expect(result.error).toMatch(/Meta needs reconnect/);
    expect(fetchAdSetsMock).not.toHaveBeenCalled();
  });
});
