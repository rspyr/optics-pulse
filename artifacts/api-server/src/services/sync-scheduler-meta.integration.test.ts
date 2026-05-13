/**
 * Real-Postgres integration test for syncMetaCampaigns.
 *
 * Uses the project's DATABASE_URL. Each test owns its own tenant (created
 * fresh, cleaned up afterwards) so it cannot interfere with other rows or
 * with parallel test runs of the mocked unit suite.
 *
 * Only MetaAPIService is stubbed — every other DB / SQL path (advisory
 * locks, ON CONFLICT upserts, sync-log finalization, tenant flag updates)
 * runs against real Postgres.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { sql, eq, and } from "drizzle-orm";
import { encryptConfig } from "../lib/encryption";
import { MetaTokenInvalidError } from "./integrations/meta";

// ─── Stub MetaAPIService BEFORE importing sync-scheduler ─────────────────────

const metaMocks = vi.hoisted(() => ({
  fetchAdSets: (..._args: unknown[]) => Promise.resolve([]) as Promise<unknown>,
  fetchAds: (..._args: unknown[]) => Promise.resolve([]) as Promise<unknown>,
  fetchAdDailyInsights: (..._args: unknown[]) => Promise.resolve([]) as Promise<unknown>,
}));

vi.mock("./integrations/meta", async () => {
  const actual = await vi.importActual<typeof import("./integrations/meta")>("./integrations/meta");
  class MockMetaAPIService {
    fetchAdSets(...a: unknown[]) { return metaMocks.fetchAdSets(...a); }
    fetchAds(...a: unknown[]) { return metaMocks.fetchAds(...a); }
    fetchAdDailyInsights(...a: unknown[]) { return metaMocks.fetchAdDailyInsights(...a); }
  }
  return { ...actual, MetaAPIService: MockMetaAPIService };
});

// Notifications are noisy and not under test here.
vi.mock("./notifications", () => ({ emitSyncFailureNotification: vi.fn().mockResolvedValue(undefined) }));

// Import lazily after mocks are registered.
const dbModule = await import("@workspace/db");
const { db, pool, tenantsTable, metaAdSetsTable, metaAdsTable, metaAdDailyStatsTable, campaignsTable, campaignDailyStatsTable, integrationSyncLogsTable } = dbModule;
const { syncMetaCampaigns } = await import("./sync-scheduler");

const TODAY = new Date().toISOString().slice(0, 10);
const ACCOUNT_ID = "999000111";

async function resyncSerial(table: string, idCol = "id"): Promise<void> {
  await db.execute(sql.raw(
    `SELECT setval(pg_get_serial_sequence('${table}','${idCol}'), COALESCE((SELECT MAX(${idCol}) FROM ${table}), 0) + 1, false)`,
  ));
}

async function createTestTenant(slugSuffix: string): Promise<number> {
  // The shared dev DB occasionally has rows inserted with explicit ids
  // (seeds, fixtures from other tests), leaving the serial sequence behind
  // the actual MAX(id). Resync before every insert to keep this test robust.
  await resyncSerial("tenants");
  const slug = `meta-int-test-${slugSuffix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const [row] = await db.insert(tenantsTable).values({
    name: `Meta Int Test ${slug}`,
    clientSlug: slug,
    apiConfig: encryptConfig({
      metaAccessToken: "fake-token",
      metaAdAccountId: `act_${ACCOUNT_ID}`,
    }) as unknown as typeof tenantsTable.$inferInsert.apiConfig,
  }).returning();
  return row.id;
}

async function deleteTenantCascade(tenantId: number): Promise<void> {
  // Order matters: delete child rows before tenant.
  await db.delete(campaignDailyStatsTable).where(sql`campaign_id IN (SELECT id FROM campaigns WHERE tenant_id = ${tenantId})`);
  await db.delete(campaignsTable).where(eq(campaignsTable.tenantId, tenantId));
  await db.delete(metaAdDailyStatsTable).where(eq(metaAdDailyStatsTable.tenantId, tenantId));
  await db.delete(metaAdsTable).where(eq(metaAdsTable.tenantId, tenantId));
  await db.delete(metaAdSetsTable).where(eq(metaAdSetsTable.tenantId, tenantId));
  await db.delete(integrationSyncLogsTable).where(eq(integrationSyncLogsTable.tenantId, tenantId));
  await db.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
}

const createdTenants: number[] = [];

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  // The sync code's `onConflictDoUpdate({ target: [campaignId, date] })` needs
  // a unique index on (campaign_id, date). Older dev DBs may be missing it,
  // so create it idempotently here. Production schema/migrations should
  // own this; this is a test-environment safety net only.
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS campaign_daily_stats_campaign_date_uq ON campaign_daily_stats (campaign_id, date)`);
});

afterAll(async () => {
  for (const id of createdTenants) {
    try { await deleteTenantCascade(id); } catch { /* best-effort */ }
  }
  vi.restoreAllMocks();
});

beforeEach(() => {
  metaMocks.fetchAdSets = () => Promise.resolve([]);
  metaMocks.fetchAds = () => Promise.resolve([]);
  metaMocks.fetchAdDailyInsights = () => Promise.resolve([]);
});

describe("syncMetaCampaigns (real Postgres)", () => {
  it("upserts ad sets, ads, per-ad daily stats, and campaign rollups; second run with new values overwrites via ON CONFLICT", async () => {
    const tenantId = await createTestTenant("happy");
    createdTenants.push(tenantId);

    metaMocks.fetchAdSets = () => Promise.resolve([
      { id: "as_int_1", name: "Set 1", campaign_id: "c_int_1", effective_status: "ACTIVE", daily_budget: "1000" },
    ]);
    metaMocks.fetchAds = () => Promise.resolve([
      { id: "ad_int_1", name: "Ad 1", adset_id: "as_int_1", campaign_id: "c_int_1", effective_status: "ACTIVE", creative: { id: "cr_1" } },
    ]);
    metaMocks.fetchAdDailyInsights = () => Promise.resolve([
      {
        ad_id: "ad_int_1", ad_name: "Ad 1", adset_id: "as_int_1",
        campaign_id: "c_int_1", campaign_name: "Campaign One",
        date_start: TODAY, date_stop: TODAY,
        spend: "12.50", impressions: "1000", clicks: "30",
        actions: [{ action_type: "lead", value: "4" }, { action_type: "purchase", value: "2" }],
      },
    ]);

    const r1 = await syncMetaCampaigns(tenantId);
    expect(r1.error).toBeUndefined();
    expect(r1.synced).toBe(1);

    // Verify rows landed.
    const adSets = await db.select().from(metaAdSetsTable).where(eq(metaAdSetsTable.tenantId, tenantId));
    expect(adSets).toHaveLength(1);
    expect(adSets[0].externalId).toBe("as_int_1");
    expect(adSets[0].dailyBudgetCents).toBe(1000);

    const ads = await db.select().from(metaAdsTable).where(eq(metaAdsTable.tenantId, tenantId));
    expect(ads).toHaveLength(1);
    expect(ads[0].name).toBe("Ad 1");

    const adDay = await db.select().from(metaAdDailyStatsTable).where(eq(metaAdDailyStatsTable.tenantId, tenantId));
    expect(adDay).toHaveLength(1);
    expect(adDay[0].adExternalId).toBe("ad_int_1");
    expect(adDay[0].spend).toBeCloseTo(12.5, 5);
    expect(adDay[0].impressions).toBe(1000);
    expect(adDay[0].clicks).toBe(30);
    expect(adDay[0].conversions).toBe(6); // lead(4) + purchase(2)

    const campaigns = await db.select().from(campaignsTable).where(eq(campaignsTable.tenantId, tenantId));
    expect(campaigns).toHaveLength(1);
    expect(campaigns[0].externalId).toBe("c_int_1");
    expect(campaigns[0].name).toBe("Campaign One");

    const cds = await db.select().from(campaignDailyStatsTable)
      .where(and(eq(campaignDailyStatsTable.campaignId, campaigns[0].id), eq(campaignDailyStatsTable.date, TODAY)));
    expect(cds).toHaveLength(1);
    expect(cds[0].spend).toBeCloseTo(12.5, 5);

    // Sync log finalized as completed.
    const logs = await db.select().from(integrationSyncLogsTable)
      .where(and(eq(integrationSyncLogsTable.tenantId, tenantId), eq(integrationSyncLogsTable.integration, "meta")));
    expect(logs.some((l) => l.status === "completed" && (l.recordsProcessed ?? 0) === 1)).toBe(true);

    // Tenant flags reset.
    const [tenantAfter] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId));
    expect(tenantAfter.metaNeedsReconnect).toBe(false);
    expect(tenantAfter.metaReconnectReason).toBeNull();
    expect(tenantAfter.metaLastSyncedAt).not.toBeNull();

    // ── Second run with mutated values exercises ON CONFLICT DO UPDATE.
    metaMocks.fetchAdSets = () => Promise.resolve([
      { id: "as_int_1", name: "Set 1 RENAMED", campaign_id: "c_int_1", effective_status: "PAUSED", daily_budget: "2500" },
    ]);
    metaMocks.fetchAdDailyInsights = () => Promise.resolve([
      {
        ad_id: "ad_int_1", ad_name: "Ad 1 v2", adset_id: "as_int_1",
        campaign_id: "c_int_1", campaign_name: "Campaign One",
        date_start: TODAY, date_stop: TODAY,
        spend: "99.99", impressions: "5000", clicks: "150",
        actions: [{ action_type: "lead", value: "10" }],
      },
    ]);

    const r2 = await syncMetaCampaigns(tenantId);
    expect(r2.error).toBeUndefined();

    const adSetsAfter = await db.select().from(metaAdSetsTable).where(eq(metaAdSetsTable.tenantId, tenantId));
    expect(adSetsAfter).toHaveLength(1); // ON CONFLICT, not duplicate
    expect(adSetsAfter[0].name).toBe("Set 1 RENAMED");
    expect(adSetsAfter[0].effectiveStatus).toBe("PAUSED");
    expect(adSetsAfter[0].dailyBudgetCents).toBe(2500);

    const adDayAfter = await db.select().from(metaAdDailyStatsTable).where(eq(metaAdDailyStatsTable.tenantId, tenantId));
    expect(adDayAfter).toHaveLength(1);
    expect(adDayAfter[0].spend).toBeCloseTo(99.99, 4);
    expect(adDayAfter[0].impressions).toBe(5000);
    expect(adDayAfter[0].conversions).toBe(10);

    const cdsAfter = await db.select().from(campaignDailyStatsTable)
      .where(and(eq(campaignDailyStatsTable.campaignId, campaigns[0].id), eq(campaignDailyStatsTable.date, TODAY)));
    expect(cdsAfter).toHaveLength(1);
    expect(cdsAfter[0].spend).toBeCloseTo(99.99, 4);
    expect(cdsAfter[0].clicks).toBe(150);
  });

  it("refuses to run when another holder owns the per-tenant advisory lock", async () => {
    const tenantId = await createTestTenant("lock");
    createdTenants.push(tenantId);

    // Manually grab the same advisory lock on a *different* connection so the
    // sync's pg_try_advisory_lock returns false. Use a dedicated client so
    // we don't release the pool's session-state.
    const client = await pool.connect();
    try {
      const grab = await client.query("SELECT pg_try_advisory_lock($1, $2) AS got", [0x4d455441, tenantId]);
      expect(grab.rows[0].got).toBe(true);

      let syncStarted = false;
      metaMocks.fetchAdSets = () => { syncStarted = true; return Promise.resolve([]); };
      metaMocks.fetchAds = () => { syncStarted = true; return Promise.resolve([]); };
      metaMocks.fetchAdDailyInsights = () => { syncStarted = true; return Promise.resolve([]); };

      const result = await syncMetaCampaigns(tenantId);

      expect(result.synced).toBe(0);
      expect(result.error).toMatch(/Another Meta sync is already running/);
      expect(syncStarted).toBe(false);

      // Sync log marked error.
      const logs = await db.select().from(integrationSyncLogsTable)
        .where(and(eq(integrationSyncLogsTable.tenantId, tenantId), eq(integrationSyncLogsTable.integration, "meta")));
      expect(logs.some((l) => l.status === "error" && /already running/i.test(l.errorMessage || ""))).toBe(true);
    } finally {
      await client.query("SELECT pg_advisory_unlock($1, $2)", [0x4d455441, tenantId]);
      client.release();
    }

    // After the external lock is released, the next sync should succeed.
    metaMocks.fetchAdSets = () => Promise.resolve([]);
    metaMocks.fetchAds = () => Promise.resolve([]);
    metaMocks.fetchAdDailyInsights = () => Promise.resolve([]);
    const ok = await syncMetaCampaigns(tenantId);
    expect(ok.error).toBeUndefined();
  });

  it("flags metaNeedsReconnect on the persisted tenant row when MetaTokenInvalidError is thrown", async () => {
    const tenantId = await createTestTenant("token");
    createdTenants.push(tenantId);

    metaMocks.fetchAdSets = () => Promise.reject(new MetaTokenInvalidError("Session has expired", 190, 463));

    const result = await syncMetaCampaigns(tenantId);
    expect(result.synced).toBe(0);
    expect(result.error).toMatch(/Session has expired/);

    const [t] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId));
    expect(t.metaNeedsReconnect).toBe(true);
    expect(t.metaReconnectReason).toMatch(/Session has expired/);

    const logs = await db.select().from(integrationSyncLogsTable)
      .where(and(eq(integrationSyncLogsTable.tenantId, tenantId), eq(integrationSyncLogsTable.integration, "meta")));
    expect(logs.some((l) => l.status === "error" && /Session has expired/.test(l.errorMessage || ""))).toBe(true);

    // Subsequent sync short-circuits because the flag is now set.
    metaMocks.fetchAdSets = vi.fn(() => Promise.resolve([]));
    const second = await syncMetaCampaigns(tenantId);
    expect(second.error).toMatch(/Meta needs reconnect/);
    expect(metaMocks.fetchAdSets).not.toHaveBeenCalled();
  });
});
