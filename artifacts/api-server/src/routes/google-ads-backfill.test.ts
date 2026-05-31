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
    campaignsTable: {
      __name: "campaigns",
      tenantId: "c.tenantId", platform: "c.platform", externalId: "c.externalId", id: "c.id",
    },
    campaignDailyStatsTable: {
      __name: "campaign_daily_stats",
      campaignId: "cds.campaignId", date: "cds.date", id: "cds.id",
    },
    integrationSyncLogsTable: { __name: "integration_sync_logs", id: "isl.id" },
    metaAdDailyStatsTable: { __name: "meta_ad_daily_stats" },
    metaAdAccountsTable: { __name: "meta_ad_accounts" },
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
  notInArray: vi.fn((...args: unknown[]) => ({ __op: "notInArray", args })),
  inArray: vi.fn((...args: unknown[]) => ({ __op: "inArray", args })),
  count: vi.fn((a: unknown) => ({ __op: "count", a })),
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
  hashStJobId: vi.fn((stJobId: string) => `hash-${stJobId}`),
}));
vi.mock("../services/integrations/podium", () => ({ syncPodiumReviews: vi.fn() }));
vi.mock("../services/integrations/meta", async () => {
  const actual = await vi.importActual<typeof import("../services/integrations/meta")>(
    "../services/integrations/meta",
  );
  class MockMetaAPIService {
    fetchAdDailyInsights() { return Promise.resolve([]); }
    fetchAdSets() { return Promise.resolve([]); }
    fetchAds() { return Promise.resolve([]); }
    listAdAccounts() { return Promise.resolve([]); }
    verifyToken() { return Promise.resolve({}); }
  }
  return { ...actual, MetaAPIService: MockMetaAPIService };
});

// Mock the Google Ads service module — expose configurable spies.
const gaMocks = vi.hoisted(() => ({
  fetchCampaignPerformance: vi.fn(),
  formatCampaignRow: vi.fn(),
}));

vi.mock("../services/integrations/google-ads", () => ({
  fetchCampaignPerformance: gaMocks.fetchCampaignPerformance,
  formatCampaignRow: gaMocks.formatCampaignRow,
}));

// ─── Test app + helpers ──────────────────────────────────────────────────────

let app: express.Express;

async function setupApp() {
  vi.resetModules();
  const mod = await import("./integrations");
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

function tenantWithGoogleAds(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 7,
    name: "Acme",
    apiConfig: encryptConfig({
      googleAdsApiKey: "ya29.tok",
      googleAdsDeveloperToken: "dev-tok",
      googleAdsCustomerId: "123-456-7890",
    }),
    ...overrides,
  };
}

beforeEach(async () => {
  state.reset();
  gaMocks.fetchCampaignPerformance.mockReset();
  gaMocks.formatCampaignRow.mockReset();
  // The sync-log insert returns a row with id=1 so logSync().id resolves.
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

describe("POST /integrations/google_ads/backfill — days validation", () => {
  it("rejects days <= 30 with 400 (hourly sync already covers that window)", async () => {
    const res = await postJson("/integrations/google_ads/backfill", { tenantId: 7, days: 30 });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/days must be a number > 30/);
    // Should short-circuit before any sync log is written.
    expect(state.insertCalls.find((c) => c.table === "integration_sync_logs")).toBeUndefined();
    expect(gaMocks.fetchCampaignPerformance).not.toHaveBeenCalled();
  });

  it("rejects days > 730 with 400 (Google Ads ~24-month retention cap)", async () => {
    const res = await postJson("/integrations/google_ads/backfill", { tenantId: 7, days: 731 });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/cannot exceed 730/);
    expect(state.insertCalls.find((c) => c.table === "integration_sync_logs")).toBeUndefined();
    expect(gaMocks.fetchCampaignPerformance).not.toHaveBeenCalled();
  });

  it("rejects missing tenantId with 400", async () => {
    const res = await postJson("/integrations/google_ads/backfill", { days: 60 });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/tenantId required/);
  });
});

describe("POST /integrations/google_ads/backfill — early exits", () => {
  it("returns 404 when the tenant doesn't exist (no sync log opened)", async () => {
    state.selectQueue.push([]);
    const res = await postJson("/integrations/google_ads/backfill", { tenantId: 999, days: 60 });
    expect(res.status).toBe(404);
    expect(String(res.body.error)).toMatch(/tenant not found/i);
    // Tenant-not-found short-circuits before the sync log row is opened.
    expect(state.insertCalls.find((c) => c.table === "integration_sync_logs")).toBeUndefined();
    expect(gaMocks.fetchCampaignPerformance).not.toHaveBeenCalled();
  });

  it("returns 400 when the tenant has no Google Ads config and finalizes the backfill log as error", async () => {
    state.selectQueue.push([{ id: 7, apiConfig: null }]);
    const res = await postJson("/integrations/google_ads/backfill", { tenantId: 7, days: 60 });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/google ads not configured/i);
    expect(gaMocks.fetchCampaignPerformance).not.toHaveBeenCalled();

    // A sync_type='backfill' log row was opened and immediately closed as 'error'
    // so the Settings panel can surface the misconfiguration.
    const opened = state.insertCalls.find((c) => c.table === "integration_sync_logs");
    expect(opened).toBeDefined();
    const row = opened!.values[0] as Record<string, unknown>;
    expect(row.integration).toBe("google_ads");
    expect(row.syncType).toBe("backfill");
    expect(row.status).toBe("running");

    const errLog = state.updateCalls.find(
      (u) => u.table === "integration_sync_logs" && u.set.status === "error",
    );
    expect(errLog).toBeDefined();
    expect(String(errLog!.set.errorMessage)).toMatch(/google ads not configured/i);
  });
});

describe("POST /integrations/google_ads/backfill — successful run", () => {
  it("writes campaigns + campaign_daily_stats and a 'completed' backfill sync log", async () => {
    // Order of db.select() calls inside backfillGoogleAdsCampaigns:
    //   1. tenants
    //   2. campaigns lookup for the row in chunk 1 (will INSERT)
    //   3. campaign_daily_stats lookup for that row (will INSERT)
    //   chunk 2 returns 0 rows, so no further selects happen there.
    state.selectQueue.push([tenantWithGoogleAds()]);
    state.selectQueue.push([]); // campaigns lookup → not found
    state.selectQueue.push([]); // campaign_daily_stats lookup → not found

    // Per-tenant advisory lock acquired (shared with the hourly sync).
    state.executeQueue.push({ rows: [{ got: true }] });

    // Insert into campaigns returns the new campaign id used by the rollup.
    state.insertReturning.set("campaigns", [{ id: 100 }]);

    // 31-day window → 2 chunks. Only chunk 1 has data.
    gaMocks.formatCampaignRow.mockImplementation(() => ({
      platform: "google_ads",
      externalId: "ga-c1",
      name: "Campaign One",
      status: "ENABLED",
      date: "2026-04-01",
      spend: "12.50",
      impressions: 800,
      clicks: 25,
      conversions: 4,
    }));
    gaMocks.fetchCampaignPerformance.mockResolvedValueOnce([{ raw: "row-1" }]);
    gaMocks.fetchCampaignPerformance.mockResolvedValue([]);

    const res = await postJson("/integrations/google_ads/backfill", { tenantId: 7, days: 31 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.synced).toBe(1);
    expect(typeof res.body.chunks).toBe("number");
    expect(res.body.chunks as number).toBeGreaterThanOrEqual(2);

    // Google Ads API was invoked once per chunk with (since, until) ISO dates.
    expect(gaMocks.fetchCampaignPerformance).toHaveBeenCalledTimes(res.body.chunks as number);
    for (const call of gaMocks.fetchCampaignPerformance.mock.calls) {
      expect(typeof call[1]).toBe("string");
      expect(typeof call[2]).toBe("string");
      expect(call[1]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(call[2]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }

    // A new campaign row was inserted with the formatted external id.
    const campIns = state.insertCalls.find((c) => c.table === "campaigns");
    expect(campIns).toBeDefined();
    expect((campIns!.values[0] as Record<string, unknown>).externalId).toBe("ga-c1");
    expect((campIns!.values[0] as Record<string, unknown>).platform).toBe("google_ads");

    // A campaign_daily_stats row was inserted for that campaign id.
    const cds = state.insertCalls.find((c) => c.table === "campaign_daily_stats");
    expect(cds).toBeDefined();
    const cdsRow = cds!.values[0] as Record<string, unknown>;
    expect(cdsRow.campaignId).toBe(100);
    expect(cdsRow.date).toBe("2026-04-01");

    // The sync log was opened with sync_type='backfill' and finalized as completed.
    const opened = state.insertCalls.find((c) => c.table === "integration_sync_logs");
    expect(opened).toBeDefined();
    const openedRow = opened!.values[0] as Record<string, unknown>;
    expect(openedRow.integration).toBe("google_ads");
    expect(openedRow.syncType).toBe("backfill");
    expect(openedRow.status).toBe("running");

    const completed = state.updateCalls.find(
      (u) => u.table === "integration_sync_logs" && u.set.status === "completed",
    );
    expect(completed).toBeDefined();
    expect(completed!.set.recordsProcessed).toBe(1);
    expect(completed!.set.errorMessage).toBeNull();

    // Once fetching completes and the upsert loop begins, the phase advances
    // to "saving results" and the writer publishes sub-chunk row progress
    // (progressChunkRecords out of progressTotalRecords = rows in this chunk)
    // so the /sync-status route can move the percent WITHIN the chunk, not
    // just at chunk boundaries.
    const savingWrite = state.updateCalls.find(
      (u) => u.table === "integration_sync_logs" && u.set.progressPhase === "saving results",
    );
    expect(savingWrite).toBeDefined();
    expect(savingWrite!.set.progressTotalRecords).toBe(1); // chunk 1 held 1 row
    expect(savingWrite!.set.progressChunkRecords).toBe(0); // seeded before the loop

    // Every chunk-start ("fetching campaigns") write must RESET the sub-chunk
    // counters to null. Here chunk 2 has zero rows and never reaches the
    // "saving results" seed, so without this reset chunk 1's sub-chunk values
    // would leak forward and the /sync-status route would blend a stale
    // fraction into chunk 2's percent. Both counters must be null on each
    // chunk-start write.
    const fetchingWrites = state.updateCalls.filter(
      (u) => u.table === "integration_sync_logs" && u.set.progressPhase === "fetching campaigns",
    );
    expect(fetchingWrites.length).toBe(res.body.chunks as number);
    for (const w of fetchingWrites) {
      expect(w.set.progressChunkRecords).toBeNull();
      expect(w.set.progressTotalRecords).toBeNull();
    }

    // The completion write clears the in-flight sub-chunk column so a finished
    // row doesn't keep reporting stale progress.
    expect(completed!.set.progressChunkRecords).toBeNull();
  });

  it("resets sub-chunk counters at each chunk boundary so a prior chunk's row progress can't leak into the next chunk", async () => {
    // Two data-bearing chunks. After chunk 1 publishes sub-chunk progress
    // (progressChunkRecords/progressTotalRecords), chunk 2's chunk-start write
    // must reset both to null so /sync-status falls back to chunk 2's baseline
    // percent instead of blending chunk 1's stale fraction.
    state.selectQueue.push([tenantWithGoogleAds()]);
    state.selectQueue.push([]); // chunk 1: campaigns lookup → insert
    state.selectQueue.push([]); // chunk 1: campaign_daily_stats lookup → insert
    state.selectQueue.push([]); // chunk 2: campaigns lookup → insert
    state.selectQueue.push([]); // chunk 2: campaign_daily_stats lookup → insert

    state.executeQueue.push({ rows: [{ got: true }] });
    state.insertReturning.set("campaigns", [{ id: 100 }]);

    gaMocks.formatCampaignRow.mockImplementation(() => ({
      platform: "google_ads",
      externalId: "ga-c1",
      name: "Campaign One",
      status: "ENABLED",
      date: "2026-04-01",
      spend: "1.00",
      impressions: 10,
      clicks: 1,
      conversions: 0,
    }));
    // 31-day window → 2 chunks; both return one row.
    gaMocks.fetchCampaignPerformance.mockResolvedValueOnce([{ raw: "row-c1" }]);
    gaMocks.fetchCampaignPerformance.mockResolvedValueOnce([{ raw: "row-c2" }]);
    gaMocks.fetchCampaignPerformance.mockResolvedValue([]);

    const res = await postJson("/integrations/google_ads/backfill", { tenantId: 7, days: 31 });
    expect(res.status).toBe(200);
    expect(res.body.chunks as number).toBeGreaterThanOrEqual(2);

    const islWrites = state.updateCalls.filter((u) => u.table === "integration_sync_logs");
    // Every chunk-start write resets the sub-chunk counters regardless of what
    // the previous chunk published.
    const fetchingWrites = islWrites.filter((u) => u.set.progressPhase === "fetching campaigns");
    expect(fetchingWrites.length).toBe(res.body.chunks as number);
    for (const w of fetchingWrites) {
      expect(w.set.progressChunkRecords).toBeNull();
      expect(w.set.progressTotalRecords).toBeNull();
    }

    // Sanity: each data-bearing chunk still seeds its own "saving results"
    // sub-chunk progress (chunkDone 0 of the chunk's row count).
    const savingWrites = islWrites.filter((u) => u.set.progressPhase === "saving results");
    expect(savingWrites.length).toBeGreaterThanOrEqual(2);
    for (const w of savingWrites) {
      expect(w.set.progressTotalRecords).toBe(1);
    }
  });
});

describe("POST /integrations/google_ads/backfill — cooperative cancel", () => {
  it("finalizes the sync log as 'cancelled' (not error) at a chunk boundary, preserving rows already saved", async () => {
    // Chunk 1 saves one row; at the chunk-2 boundary the cancel flag is set,
    // so the run unwinds cleanly. The chunk-boundary checkCancel reads the
    // cancelRequested flag off the sync log row.
    //
    // db.select() order inside backfillGoogleAdsCampaigns:
    //   1. tenants
    //   2. checkCancel @ chunk 0 boundary → not cancelled
    //   3. campaigns lookup (chunk 0 row) → insert
    //   4. campaign_daily_stats lookup (chunk 0 row) → insert
    //   5. checkCancel @ chunk 1 boundary → cancelled → break
    state.selectQueue.push([tenantWithGoogleAds()]);
    state.selectQueue.push([{ cancel: false }]); // chunk 0 boundary: keep going
    state.selectQueue.push([]); // campaigns lookup → not found → insert
    state.selectQueue.push([]); // campaign_daily_stats lookup → not found → insert
    state.selectQueue.push([{ cancel: true }]); // chunk 1 boundary: cancel!

    state.executeQueue.push({ rows: [{ got: true }] });
    state.insertReturning.set("campaigns", [{ id: 100 }]);

    gaMocks.formatCampaignRow.mockReturnValue({
      platform: "google_ads",
      externalId: "ga-c1",
      name: "Campaign One",
      status: "ENABLED",
      date: "2026-04-01",
      spend: "1.00",
      impressions: 10,
      clicks: 1,
      conversions: 0,
    });
    // 31-day window → 2 chunks. Chunk 0 returns one row; chunk 1 is never
    // fetched because we break at its boundary.
    gaMocks.fetchCampaignPerformance.mockResolvedValueOnce([{ raw: "row-1" }]);
    gaMocks.fetchCampaignPerformance.mockResolvedValue([]);

    const res = await postJson("/integrations/google_ads/backfill", { tenantId: 7, days: 31 });

    // A deliberate cancel resolves as a 200 success with cancelled:true, not a
    // 502 failure.
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.cancelled).toBe(true);
    expect(res.body.synced).toBe(1);

    // Only chunk 0 was fetched — we broke at the chunk-1 boundary.
    expect(gaMocks.fetchCampaignPerformance).toHaveBeenCalledTimes(1);

    // The sync log was finalized as 'cancelled' (not 'error'), keeping the one
    // row already synced.
    const cancelledLog = state.updateCalls.find(
      (u) => u.table === "integration_sync_logs" && u.set.status === "cancelled",
    );
    expect(cancelledLog).toBeDefined();
    expect(cancelledLog!.set.recordsProcessed).toBe(1);
    expect(String(cancelledLog!.set.errorMessage)).toMatch(/cancelled by operator/i);

    // No 'error' status was ever written, and no partial-failure row was set.
    expect(
      state.updateCalls.find((u) => u.table === "integration_sync_logs" && u.set.status === "error"),
    ).toBeUndefined();
    expect(
      state.updateCalls.find((u) => u.table === "integration_sync_logs" && u.set.partial === true),
    ).toBeUndefined();
  });

  it("cancels before any work when the flag is already set at the first chunk boundary (zero rows synced)", async () => {
    state.selectQueue.push([tenantWithGoogleAds()]);
    state.selectQueue.push([{ cancel: true }]); // chunk 0 boundary: cancel immediately

    state.executeQueue.push({ rows: [{ got: true }] });

    const res = await postJson("/integrations/google_ads/backfill", { tenantId: 7, days: 31 });

    expect(res.status).toBe(200);
    expect(res.body.cancelled).toBe(true);
    expect(res.body.synced).toBe(0);

    // Nothing was fetched — we cancelled before the first chunk's fetch.
    expect(gaMocks.fetchCampaignPerformance).not.toHaveBeenCalled();

    const cancelledLog = state.updateCalls.find(
      (u) => u.table === "integration_sync_logs" && u.set.status === "cancelled",
    );
    expect(cancelledLog).toBeDefined();
    expect(cancelledLog!.set.recordsProcessed).toBe(0);
  });

  it("stops mid-chunk within a few seconds via the dedicated cancel poll, before the ~30s progress flush would fire", async () => {
    // A single large chunk with two rows. The in-loop cancel check now runs on
    // its own ~3s cadence (CANCEL_POLL_MIN_INTERVAL_MS), decoupled from the
    // ~30s progress flush (HEARTBEAT_MIN_INTERVAL_MS). We advance a mocked
    // clock by 5s per row: that's past the 3s cancel cadence but well under the
    // 30s flush cadence, so after row 1 the cancel poll fires and unwinds
    // BEFORE row 2 is processed and WITHOUT a progress flush. Under the old
    // (bundled) behaviour the cancel rode the 30s flush, so 5s of elapsed time
    // wouldn't have triggered it and both rows would have been saved.
    let mockNow = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => mockNow);

    // db.select() order:
    //   1. tenants
    //   2. checkCancel @ chunk 0 boundary → not cancelled
    //   3. row 1 campaigns lookup → insert
    //   4. row 1 campaign_daily_stats lookup → insert
    //   5. in-loop cancel poll after row 1 → cancelled → throw (row 2 untouched)
    state.selectQueue.push([tenantWithGoogleAds()]);
    state.selectQueue.push([{ cancel: false }]); // chunk 0 boundary: keep going
    state.selectQueue.push([]); // row 1 campaigns lookup → insert
    state.selectQueue.push([]); // row 1 campaign_daily_stats lookup → insert
    state.selectQueue.push([{ cancel: true }]); // in-loop poll after row 1: cancel!

    state.executeQueue.push({ rows: [{ got: true }] });
    state.insertReturning.set("campaigns", [{ id: 100 }]);

    // Each formatted row advances the clock 5s — past the 3s cancel cadence,
    // under the 30s flush cadence.
    gaMocks.formatCampaignRow.mockImplementation(() => {
      mockNow += 5_000;
      return {
        platform: "google_ads",
        externalId: "ga-c1",
        name: "Campaign One",
        status: "ENABLED",
        date: "2026-04-01",
        spend: "1.00",
        impressions: 10,
        clicks: 1,
        conversions: 0,
      };
    });
    // Chunk 0 holds two rows; chunk 1 is never fetched (we throw mid-chunk-0).
    gaMocks.fetchCampaignPerformance.mockResolvedValueOnce([{ raw: "row-1" }, { raw: "row-2" }]);
    gaMocks.fetchCampaignPerformance.mockResolvedValue([]);

    const res = await postJson("/integrations/google_ads/backfill", { tenantId: 7, days: 31 });

    expect(res.status).toBe(200);
    expect(res.body.cancelled).toBe(true);
    // Only the FIRST row was saved — the cancel poll fired after row 1 and
    // before row 2. (The old 30s-bundled behaviour would have saved both.)
    expect(res.body.synced).toBe(1);

    // Only chunk 0 was fetched — we threw before reaching the chunk-1 boundary.
    expect(gaMocks.fetchCampaignPerformance).toHaveBeenCalledTimes(1);
    // formatCampaignRow ran for row 1 only; row 2 was never reached.
    expect(gaMocks.formatCampaignRow).toHaveBeenCalledTimes(1);

    const cancelledLog = state.updateCalls.find(
      (u) => u.table === "integration_sync_logs" && u.set.status === "cancelled",
    );
    expect(cancelledLog).toBeDefined();
    expect(cancelledLog!.set.recordsProcessed).toBe(1);

    // The cancel fired WITHOUT a mid-chunk progress flush: the only
    // "saving results" write is the pre-loop seed (progressChunkRecords === 0).
    // A throttled in-flight flush after row 1 would have written
    // progressChunkRecords === 1, which must not happen at only 5s elapsed.
    const flushedAfterRow = state.updateCalls.find(
      (u) => u.table === "integration_sync_logs"
        && u.set.progressPhase === "saving results"
        && typeof u.set.progressChunkRecords === "number"
        && (u.set.progressChunkRecords as number) >= 1,
    );
    expect(flushedAfterRow).toBeUndefined();

    // Never finalized as 'error' and no partial-failure row was written.
    expect(
      state.updateCalls.find((u) => u.table === "integration_sync_logs" && u.set.status === "error"),
    ).toBeUndefined();
    expect(
      state.updateCalls.find((u) => u.table === "integration_sync_logs" && u.set.partial === true),
    ).toBeUndefined();
  });
});

describe("POST /integrations/google_ads/backfill — partial failure mid-chunk", () => {
  it("writes a 'partial: …' progress message and finalizes the backfill log as error when a later chunk throws", async () => {
    // Chunk 1 inserts one campaign + one stat row, then chunk 2 throws.
    state.selectQueue.push([tenantWithGoogleAds()]);
    state.selectQueue.push([]); // campaigns lookup → not found
    state.selectQueue.push([]); // campaign_daily_stats lookup → not found

    state.executeQueue.push({ rows: [{ got: true }] });

    state.insertReturning.set("campaigns", [{ id: 100 }]);

    gaMocks.formatCampaignRow.mockReturnValue({
      platform: "google_ads",
      externalId: "ga-c1",
      name: "Campaign One",
      status: "ENABLED",
      date: "2026-04-01",
      spend: "1.00",
      impressions: 10,
      clicks: 1,
      conversions: 0,
    });
    gaMocks.fetchCampaignPerformance.mockResolvedValueOnce([{ raw: "row-1" }]);
    gaMocks.fetchCampaignPerformance.mockRejectedValueOnce(
      new Error("Google Ads API quota exceeded"),
    );

    const res = await postJson("/integrations/google_ads/backfill", { tenantId: 7, days: 31 });

    // Route maps unknown errors (not 'tenant not found' / 'not configured') to 502.
    expect(res.status).toBe(502);
    expect(res.body.success).toBe(false);
    expect(String(res.body.error)).toMatch(/quota exceeded/i);

    // The inner catch wrote a partial-failure progress row to the open log
    // row BEFORE the outer catch finalized it as error. Task #395: this
    // now lands as structured columns (`partial: true`, `errorCode: …`)
    // plus the raw inner message in `errorMessage`, instead of stuffing
    // a `partial: <msg>` string into errorMessage.
    const partialUpdate = state.updateCalls.find(
      (u) => u.table === "integration_sync_logs"
        && u.set.partial === true,
    );
    expect(partialUpdate).toBeDefined();
    expect(String(partialUpdate!.set.errorMessage)).toMatch(/quota exceeded/i);
    expect(partialUpdate!.set.errorCode).toBe("rate_limit");
    expect(partialUpdate!.set.recordsProcessed).toBe(1);

    // Final outer-catch update flips the row to 'error'.
    const errLog = state.updateCalls.find(
      (u) => u.table === "integration_sync_logs" && u.set.status === "error",
    );
    expect(errLog).toBeDefined();
    expect(String(errLog!.set.errorMessage)).toMatch(/quota exceeded/i);

    // Both chunks were actually attempted (so the catch fired on a real call).
    expect(gaMocks.fetchCampaignPerformance).toHaveBeenCalledTimes(2);
  });
});
