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
  hashStJobId: vi.fn((stJobId: string) => `hash-${stJobId}`),
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

// ─── Task #561: incremental window + rate-limit-budget guardrails ────────────

describe("syncMetaCampaigns — incremental window (Task #561)", () => {
  /**
   * Pin the system date so the deterministic `(tenantId + dayOfWeek) % 7`
   * branch in `syncMetaCampaigns` is testable. The test sets a date and
   * picks the tenantId to land on either the incremental or weekly-full
   * branch.
   */
  function setupHappyPath(tenantOverrides: Partial<Record<string, unknown>> = {}) {
    state.selectQueue.push([tenantWithMeta(tenantOverrides)]);
    state.selectQueue.push([{ accountId: "999", currency: "USD" }]);
    state.executeQueue.push({ rows: [{ got: true }] });
    fetchAdSetsMock.mockResolvedValue([]);
    fetchAdsMock.mockResolvedValue([]);
    fetchAdDailyInsightsMock.mockResolvedValue([]);
  }

  it("uses a 7-day rolling window when the tenant has a fresh watermark and is NOT on its weekly-refresh day", async () => {
    // Wed 2026-05-20 UTC → getUTCDay() === 3. Pick tenantId=1 so
    // (1 + 3) % 7 === 4 ≠ 0 → incremental branch. Watermark = today, so
    // catch-up logic is a no-op and the rolling 7-day window is the floor.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T12:00:00Z"));
    try {
      const { syncMetaCampaigns } = await import("./sync-scheduler");
      setupHappyPath({ id: 1, metaLastSyncedAt: new Date("2026-05-20T12:00:00Z") });

      await syncMetaCampaigns(1);

      expect(fetchAdDailyInsightsMock).toHaveBeenCalledTimes(1);
      const [since, until] = fetchAdDailyInsightsMock.mock.calls[0];
      expect(until).toBe("2026-05-20");
      // 7 days before 2026-05-20 = 2026-05-13
      expect(since).toBe("2026-05-13");
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to the 30-day full-refresh window on the tenant's weekly-refresh day", async () => {
    // Wed 2026-05-20 UTC → dayOfWeek=3. Pick tenantId=4 so (4+3)%7===0.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T12:00:00Z"));
    try {
      const { syncMetaCampaigns } = await import("./sync-scheduler");
      // Watermark fresh enough that catch-up never widens beyond 30d.
      setupHappyPath({ id: 4, metaLastSyncedAt: new Date("2026-05-20T12:00:00Z") });

      await syncMetaCampaigns(4);

      const [since, until] = fetchAdDailyInsightsMock.mock.calls[0];
      expect(until).toBe("2026-05-20");
      // 30 days before 2026-05-20 = 2026-04-20
      expect(since).toBe("2026-04-20");
    } finally {
      vi.useRealTimers();
    }
  });

  it("widens the window via watermark catch-up when the tenant's last sync is stale (e.g. 14 days)", async () => {
    // Incremental branch (id=1, dow=3 → 4%7 !== 0) but watermark is 14 days
    // old. `since` should widen to `watermark - 7d` rather than stay pinned
    // at `today - 7d`, so we don't drop the missed 7 days of data.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T12:00:00Z"));
    try {
      const { syncMetaCampaigns } = await import("./sync-scheduler");
      setupHappyPath({ id: 1, metaLastSyncedAt: new Date("2026-05-06T12:00:00Z") });

      await syncMetaCampaigns(1);

      const [since, until] = fetchAdDailyInsightsMock.mock.calls[0];
      expect(until).toBe("2026-05-20");
      // 2026-05-06 - 7d = 2026-04-29
      expect(since).toBe("2026-04-29");
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps the catch-up window at META_MAX_CATCHUP_DAYS (default 90) for very stale tenants", async () => {
    // Watermark 6 months stale. The nightly path must not regress into
    // unbounded multi-month pulls — backfill (async report) is responsible
    // for older history.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T12:00:00Z"));
    try {
      const { syncMetaCampaigns } = await import("./sync-scheduler");
      setupHappyPath({ id: 1, metaLastSyncedAt: new Date("2025-11-01T12:00:00Z") });

      await syncMetaCampaigns(1);

      const [since] = fetchAdDailyInsightsMock.mock.calls[0];
      // 90 days before 2026-05-20 = 2026-02-19
      expect(since).toBe("2026-02-19");
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the 30-day full-refresh window on a tenant's first-ever run (no metaLastSyncedAt)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T12:00:00Z"));
    try {
      const { syncMetaCampaigns } = await import("./sync-scheduler");
      // tenantId=1 would normally be the incremental branch; first-run override wins.
      setupHappyPath({ id: 1, metaLastSyncedAt: null });

      await syncMetaCampaigns(1);

      const [since] = fetchAdDailyInsightsMock.mock.calls[0];
      expect(since).toBe("2026-04-20");
    } finally {
      vi.useRealTimers();
    }
  });

  it("calls fetchAds() without expanding the creative field on the nightly path", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T12:00:00Z"));
    try {
      const { syncMetaCampaigns } = await import("./sync-scheduler");
      setupHappyPath({ id: 1, metaLastSyncedAt: new Date("2026-05-19T12:00:00Z") });

      await syncMetaCampaigns(1);

      expect(fetchAdsMock).toHaveBeenCalledTimes(1);
      // First positional arg is the includeCreative toggle. We want it
      // explicitly false so the nightly path never re-pulls creative
      // expansion — `backfillMetaAdCreatives` is the dedicated owner.
      expect(fetchAdsMock.mock.calls[0][0]).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("auto-enqueues a backfill when the catch-up window is clamped at the cap (Task #564)", async () => {
    // Watermark ~180 days stale → nightly clamps at 90d, missed range
    // ~180d should be handed off to the async backfill route.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T12:00:00Z"));
    try {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const { syncMetaCampaigns } = await import("./sync-scheduler");
      setupHappyPath({ id: 1, metaLastSyncedAt: new Date("2025-11-21T12:00:00Z") });
      // In-flight backfill de-dupe check selects from integration_sync_logs:
      // no row → no skip → auto-enqueue path runs.
      state.selectQueue.push([]);
      // The fire-and-forget backfillMetaCampaigns reload-the-tenant select
      // happens on a microtask; queue an empty row so its early-exit short
      // circuits cleanly without surfacing unhandled promise noise.
      state.selectQueue.push([]);

      await syncMetaCampaigns(1);

      const enqueueLog = logSpy.mock.calls.find((c) =>
        typeof c[0] === "string" && c[0].includes("auto-enqueuing backfillMetaCampaigns"),
      );
      expect(enqueueLog).toBeDefined();
      // requested `days` should be ≥ 90 — the missed range past the cap.
      expect(String(enqueueLog?.[0])).toMatch(/days=1\d\d/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT auto-enqueue a second backfill when one is already running (Task #564)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T12:00:00Z"));
    try {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const { syncMetaCampaigns } = await import("./sync-scheduler");
      setupHappyPath({ id: 1, metaLastSyncedAt: new Date("2025-11-21T12:00:00Z") });
      // In-flight backfill exists → de-dupe should short-circuit.
      state.selectQueue.push([{ id: 42 }]);

      await syncMetaCampaigns(1);

      const skipLog = logSpy.mock.calls.find((c) =>
        typeof c[0] === "string" && c[0].includes("skipping auto-backfill"),
      );
      expect(skipLog).toBeDefined();
      const enqueueLog = logSpy.mock.calls.find((c) =>
        typeof c[0] === "string" && c[0].includes("auto-enqueuing backfillMetaCampaigns"),
      );
      expect(enqueueLog).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not auto-enqueue a backfill on a fresh tenant whose window was NOT clamped (Task #564)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T12:00:00Z"));
    try {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const { syncMetaCampaigns } = await import("./sync-scheduler");
      setupHappyPath({ id: 1, metaLastSyncedAt: new Date("2026-05-19T12:00:00Z") });

      await syncMetaCampaigns(1);

      const enqueueLog = logSpy.mock.calls.find((c) =>
        typeof c[0] === "string" && c[0].includes("auto-enqueuing backfillMetaCampaigns"),
      );
      expect(enqueueLog).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stamps triggered_by_sync_log_id on the meta/backfill log when auto-enqueued from nightly (Task #566)", async () => {
    const { backfillMetaCampaigns } = await import("./sync-scheduler");
    // Tenant exists but flagged for reconnect → backfillMetaCampaigns
    // inserts an integration_sync_logs row and short-circuits to error.
    // That insert MUST carry the triggered_by_sync_log_id we passed in.
    state.selectQueue.push([tenantWithMeta({ id: 1, metaNeedsReconnect: true, metaReconnectReason: "expired" })]);

    await backfillMetaCampaigns(1, 180, { triggeredBySyncLogId: 4242 });

    const islInserts = state.insertCalls.filter((c) => c.table === "integration_sync_logs");
    expect(islInserts).toHaveLength(1);
    const row = islInserts[0].values[0] as Record<string, unknown>;
    expect(row.syncType).toBe("backfill");
    expect(row.triggeredBySyncLogId).toBe(4242);
  });

  it("does not stamp triggered_by_sync_log_id on a manually-triggered backfill (Task #566)", async () => {
    const { backfillMetaCampaigns } = await import("./sync-scheduler");
    state.selectQueue.push([tenantWithMeta({ id: 1, metaNeedsReconnect: true, metaReconnectReason: "expired" })]);

    await backfillMetaCampaigns(1, 180);

    const islInserts = state.insertCalls.filter((c) => c.table === "integration_sync_logs");
    expect(islInserts).toHaveLength(1);
    const row = islInserts[0].values[0] as Record<string, unknown>;
    expect(row.triggeredBySyncLogId).toBeNull();
  });

  it("does not persist any video_* fields in the per-ad-day actions payload (dead fields dropped)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T12:00:00Z"));
    try {
      const { syncMetaCampaigns } = await import("./sync-scheduler");

      state.selectQueue.push([tenantWithMeta({ id: 1, metaLastSyncedAt: new Date("2026-05-19T12:00:00Z") })]);
      state.selectQueue.push([{ accountId: "999", currency: "USD" }]);
      // Campaign lookup for c1: not found
      state.selectQueue.push([]);
      state.executeQueue.push({ rows: [{ got: true }] });
      state.insertReturning.set("campaigns", [{ id: 100 }]);

      fetchAdSetsMock.mockResolvedValue([]);
      fetchAdsMock.mockResolvedValue([]);
      // Insights row with video_* fields present — should be ignored by the writer.
      fetchAdDailyInsightsMock.mockResolvedValue([
        {
          ad_id: "ad_1", adset_id: "as_1",
          campaign_id: "c1", date_start: "2026-05-19",
          spend: "5", impressions: "100", clicks: "5",
          actions: [{ action_type: "lead", value: "1" }],
          // Even if a future Meta payload smuggled these in, we must not write them.
          video_play_actions: [{ action_type: "video_view", value: "10" }],
          video_p100_watched_actions: [{ action_type: "video_view", value: "3" }],
        },
      ]);

      await syncMetaCampaigns(1);

      const adDailyInserts = state.insertCalls.filter((c) => c.table === "meta_ad_daily_stats");
      expect(adDailyInserts).toHaveLength(1);
      const row = adDailyInserts[0].values[0] as Record<string, unknown>;
      const actionsJson = row.actionsJson as Record<string, unknown>;
      expect(actionsJson).toBeDefined();
      expect(actionsJson.actions).toBeDefined();
      // Dead video fields are NOT written to actions_json.
      expect(actionsJson.video_play_actions).toBeUndefined();
      expect(actionsJson.video_p25_watched_actions).toBeUndefined();
      expect(actionsJson.video_p50_watched_actions).toBeUndefined();
      expect(actionsJson.video_p75_watched_actions).toBeUndefined();
      expect(actionsJson.video_p100_watched_actions).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
