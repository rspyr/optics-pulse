import { db, tenantsTable, jobsTable, campaignsTable, campaignDailyStatsTable, integrationSyncLogsTable } from "@workspace/db";
import { eq, and, isNull, isNotNull, sql } from "drizzle-orm";
import { decryptConfig } from "../lib/encryption";
import { fetchCompletedJobs, formatSTJobForSync, fetchCustomerContactsById, fetchLocationsByIds, formatLocationAddress } from "./integrations/service-titan";
import { fetchCampaignPerformance, formatCampaignRow } from "./integrations/google-ads";
import { fetchCampaignInsights, formatMetaInsight } from "./integrations/meta";
import { syncPodiumReviews } from "./integrations/podium";
import { syncCallRailCalls } from "./integrations/callrail";
import { runReconciliation } from "./reconciliation";
import crypto from "crypto";

function hashStJobId(stJobId: string): string {
  return crypto.createHash("sha256").update(stJobId).digest("hex");
}

interface TenantApiConfig {
  serviceTitanClientId?: string;
  serviceTitanClientSecret?: string;
  serviceTitanTenantId?: string;
  serviceTitanAppKey?: string;
  googleAdsApiKey?: string;
  googleAdsDeveloperToken?: string;
  googleAdsCustomerId?: string;
  googleAdsLoginCustomerId?: string;
  googleAdsAccessToken?: string;
  googleAdsRefreshToken?: string;
  googleAdsClientId?: string;
  googleAdsClientSecret?: string;
  metaAccessToken?: string;
  metaAdAccountId?: string;
  metaPixelId?: string;
  callRailApiKey?: string;
  callRailAccountId?: string;
  callRailCompanyId?: string;
  callRailSigningKey?: string;
  podiumApiToken?: string;
  podiumLocationId?: string;
}

function getTenantConfig(tenant: typeof tenantsTable.$inferSelect): TenantApiConfig | null {
  if (!tenant.apiConfig || typeof tenant.apiConfig !== "string") return null;
  try {
    return decryptConfig(tenant.apiConfig) as TenantApiConfig;
  } catch {
    return null;
  }
}

async function logSync(tenantId: number, integration: string, syncType: string, startedAt: Date) {
  const [log] = await db.insert(integrationSyncLogsTable).values({
    tenantId,
    integration,
    syncType,
    status: "running",
    startedAt,
  }).returning();
  return log;
}

async function completeSyncLog(logId: number, status: string, recordsProcessed: number, errorMessage?: string) {
  await db.update(integrationSyncLogsTable)
    .set({ status, recordsProcessed, completedAt: new Date(), errorMessage: errorMessage || null })
    .where(eq(integrationSyncLogsTable.id, logId));
}

export async function syncServiceTitanJobs(tenantId: number): Promise<{ synced: number; error?: string }> {
  const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId));
  if (!tenant) return { synced: 0, error: "Tenant not found" };

  if (tenant.stSyncPaused) {
    return { synced: 0, error: "ServiceTitan sync is paused for this tenant" };
  }

  const config = getTenantConfig(tenant);
  if (!config?.serviceTitanClientId || !config?.serviceTitanClientSecret || !config?.serviceTitanAppKey) {
    return { synced: 0, error: "ServiceTitan not configured (need Client ID, Client Secret, and App Key)" };
  }

  const syncLog = await logSync(tenantId, "service_titan", "jobs", new Date());

  try {
    const stConfig = {
      clientId: config.serviceTitanClientId,
      clientSecret: config.serviceTitanClientSecret,
      tenantId: config.serviceTitanTenantId || tenant.serviceTitanId || "",
      appKey: config.serviceTitanAppKey,
    };

    const stJobs = await fetchCompletedJobs(stConfig);
    let synced = 0;

    for (const stJob of stJobs) {
      const formatted = formatSTJobForSync(stJob);
      const jobIdHash = hashStJobId(formatted.stJobId);

      const [existingByHash] = await db.select().from(jobsTable)
        .where(and(eq(jobsTable.tenantId, tenantId), eq(jobsTable.stJobIdHash, jobIdHash)))
        .limit(1);

      const existing = existingByHash || await (async () => {
        const [byRawId] = await db.select().from(jobsTable)
          .where(and(eq(jobsTable.tenantId, tenantId), eq(jobsTable.stJobId, formatted.stJobId)))
          .limit(1);
        return byRawId;
      })();

      const stDataExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      if (existing) {
        const wasPurged = existing.customerName === null && existing.stJobId === null;
        if (wasPurged) {
          await db.update(jobsTable)
            .set({
              revenue: formatted.revenue,
              status: formatted.status,
              completedAt: formatted.completedAt,
              jobTypeName: formatted.jobTypeName || existing.jobTypeName,
              businessUnit: formatted.businessUnit || existing.businessUnit,
              updatedAt: new Date(),
            })
            .where(eq(jobsTable.id, existing.id));
        } else {
          await db.update(jobsTable)
            .set({
              revenue: formatted.revenue,
              status: formatted.status,
              completedAt: formatted.completedAt,
              customerName: formatted.customerName,
              customerPhone: formatted.customerPhone || existing.customerPhone,
              customerEmail: formatted.customerEmail || existing.customerEmail,
              serviceAddress: formatted.serviceAddress || existing.serviceAddress,
              stCustomerId: formatted.stCustomerId || existing.stCustomerId,
              stLocationId: formatted.stLocationId || existing.stLocationId,
              jobTypeName: formatted.jobTypeName || existing.jobTypeName,
              businessUnit: formatted.businessUnit || existing.businessUnit,
              stJobIdHash: jobIdHash,
              stDataExpiresAt,
              updatedAt: new Date(),
            })
            .where(eq(jobsTable.id, existing.id));
        }
      } else {
        await db.insert(jobsTable).values({ tenantId, ...formatted, stJobIdHash: jobIdHash, stDataExpiresAt });
      }
      synced++;
    }

    await completeSyncLog(syncLog.id, "completed", synced);
    console.log(`[Sync] ServiceTitan: synced ${synced} jobs for tenant ${tenantId}`);

    Promise.all([
      enrichCustomerContacts(tenantId, stConfig),
      enrichJobAddresses(tenantId, stConfig),
    ]).catch((err) => {
      console.warn(`[Sync] Background enrichment failed for tenant ${tenantId}:`, (err as Error).message);
    });

    if (synced > 0) {
      const reconciliationDelay = 60 * 60 * 1000;
      setTimeout(() => {
        console.log(`[Sync] Triggering post-sync reconciliation for tenant ${tenantId}`);
        runReconciliation(tenantId, "scheduled").catch((err) => {
          console.error(`[Sync] Post-sync reconciliation failed for tenant ${tenantId}:`, (err as Error).message);
        });
      }, reconciliationDelay);
    }

    return { synced };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await completeSyncLog(syncLog.id, "error", 0, message);
    console.error(`[Sync] ServiceTitan error for tenant ${tenantId}:`, message);
    return { synced: 0, error: message };
  }
}

async function enrichCustomerContacts(
  tenantId: number,
  stConfig: { clientId: string; clientSecret: string; tenantId: string; appKey: string },
): Promise<void> {
  const jobsNeedingEnrichment = await db.select({
    id: jobsTable.id,
    stCustomerId: jobsTable.stCustomerId,
  }).from(jobsTable).where(
    and(
      eq(jobsTable.tenantId, tenantId),
      isNotNull(jobsTable.stCustomerId),
      isNull(jobsTable.customerPhone),
      isNull(jobsTable.customerEmail),
      sql`${jobsTable.revenue} > 0`,
    ),
  );

  if (jobsNeedingEnrichment.length === 0) {
    console.log(`[Enrich] No jobs need contact enrichment for tenant ${tenantId}`);
    return;
  }

  const customerIdToJobIds = new Map<string, number[]>();
  for (const job of jobsNeedingEnrichment) {
    if (!job.stCustomerId) continue;
    const existing = customerIdToJobIds.get(job.stCustomerId) || [];
    existing.push(job.id);
    customerIdToJobIds.set(job.stCustomerId, existing);
  }

  console.log(`[Enrich] Enriching ${customerIdToJobIds.size} customers for ${jobsNeedingEnrichment.length} jobs (tenant ${tenantId})`);

  let enriched = 0;
  const entries = [...customerIdToJobIds.entries()];

  for (let i = 0; i < entries.length; i += 5) {
    const batch = entries.slice(i, i + 5);
    await Promise.allSettled(
      batch.map(async ([customerId, jobIds]) => {
        try {
          const contacts = await fetchCustomerContactsById(stConfig, parseInt(customerId));
          if (contacts.length === 0) return;

          const phoneContact = contacts.find((c) => c.type === "MobilePhone" || c.type === "Phone")
            || contacts.find((c) => c.type?.toLowerCase().includes("phone"));
          const emailContact = contacts.find((c) => c.type === "Email")
            || contacts.find((c) => c.type?.toLowerCase().includes("email"));

          const phone = phoneContact?.value || null;
          const email = emailContact?.value || null;

          if (phone || email) {
            for (const jobId of jobIds) {
              await db.update(jobsTable)
                .set({
                  ...(phone ? { customerPhone: phone } : {}),
                  ...(email ? { customerEmail: email } : {}),
                  updatedAt: new Date(),
                })
                .where(eq(jobsTable.id, jobId));
            }
            enriched++;
          }
        } catch {}
      }),
    );
  }

  console.log(`[Enrich] Done: ${enriched}/${customerIdToJobIds.size} customers enriched for tenant ${tenantId}`);
}

async function enrichJobAddresses(
  tenantId: number,
  stConfig: { clientId: string; clientSecret: string; tenantId: string; appKey: string },
): Promise<void> {
  const jobsNeedingAddresses = await db.select({
    id: jobsTable.id,
    stLocationId: jobsTable.stLocationId,
  }).from(jobsTable).where(
    and(
      eq(jobsTable.tenantId, tenantId),
      isNotNull(jobsTable.stLocationId),
      isNull(jobsTable.serviceAddress),
      sql`${jobsTable.revenue} > 0`,
    ),
  );

  if (jobsNeedingAddresses.length === 0) {
    console.log(`[Enrich] No jobs need address enrichment for tenant ${tenantId}`);
    return;
  }

  const locationIdToJobIds = new Map<number, number[]>();
  for (const job of jobsNeedingAddresses) {
    if (!job.stLocationId) continue;
    const locId = parseInt(job.stLocationId);
    const existing = locationIdToJobIds.get(locId) || [];
    existing.push(job.id);
    locationIdToJobIds.set(locId, existing);
  }

  console.log(`[Enrich] Fetching addresses for ${locationIdToJobIds.size} locations covering ${jobsNeedingAddresses.length} jobs (tenant ${tenantId})`);

  const locationIds = [...locationIdToJobIds.keys()];
  const locationMap = await fetchLocationsByIds(stConfig, locationIds);

  let enriched = 0;
  for (const [locId, jobIds] of locationIdToJobIds.entries()) {
    const location = locationMap.get(locId);
    if (!location?.address) continue;

    const addr = formatLocationAddress(location.address);

    if (addr) {
      for (const jobId of jobIds) {
        await db.update(jobsTable)
          .set({ serviceAddress: addr, updatedAt: new Date() })
          .where(eq(jobsTable.id, jobId));
      }
      enriched++;
    }
  }

  console.log(`[Enrich] Done: ${enriched}/${locationIdToJobIds.size} locations enriched for tenant ${tenantId}`);
}

export async function syncGoogleAdsCampaigns(tenantId: number): Promise<{ synced: number; error?: string }> {
  const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId));
  if (!tenant) return { synced: 0, error: "Tenant not found" };

  const config = getTenantConfig(tenant);
  if (!config?.googleAdsCustomerId) {
    return { synced: 0, error: "Google Ads not configured (missing customer ID)" };
  }
  if (!config.googleAdsDeveloperToken) {
    return { synced: 0, error: "Google Ads not configured (missing developer token)" };
  }
  const hasRefreshCredentials = config.googleAdsRefreshToken && config.googleAdsClientId && config.googleAdsClientSecret;
  if (!config.googleAdsApiKey && !hasRefreshCredentials) {
    return { synced: 0, error: "Google Ads not configured (need either an access token or OAuth refresh credentials)" };
  }

  const syncLog = await logSync(tenantId, "google_ads", "campaigns", new Date());

  try {
    const endDate = new Date().toISOString().split("T")[0];
    const startDate = new Date(Date.now() - 90 * 86400000).toISOString().split("T")[0];

    const gaConfig = {
      developerToken: config.googleAdsDeveloperToken || "",
      accessToken: config.googleAdsApiKey || "",
      refreshToken: config.googleAdsRefreshToken,
      clientId: config.googleAdsClientId,
      clientSecret: config.googleAdsClientSecret,
      customerId: config.googleAdsCustomerId,
      loginCustomerId: config.googleAdsLoginCustomerId,
    };

    const rows = await fetchCampaignPerformance(gaConfig, startDate, endDate);
    let synced = 0;

    for (const row of rows) {
      const formatted = formatCampaignRow(row);

      let [campaign] = await db.select().from(campaignsTable)
        .where(and(eq(campaignsTable.tenantId, tenantId), eq(campaignsTable.platform, "google_ads"), eq(campaignsTable.externalId, formatted.externalId)))
        .limit(1);

      if (!campaign) {
        [campaign] = await db.insert(campaignsTable).values({
          tenantId,
          platform: formatted.platform,
          externalId: formatted.externalId,
          name: formatted.name,
          status: formatted.status,
        }).returning();
      }

      const [existingStat] = await db.select().from(campaignDailyStatsTable)
        .where(and(eq(campaignDailyStatsTable.campaignId, campaign.id), eq(campaignDailyStatsTable.date, formatted.date)))
        .limit(1);

      if (existingStat) {
        await db.update(campaignDailyStatsTable)
          .set({ spend: formatted.spend, impressions: formatted.impressions, clicks: formatted.clicks, conversions: formatted.conversions })
          .where(eq(campaignDailyStatsTable.id, existingStat.id));
      } else {
        await db.insert(campaignDailyStatsTable).values({
          campaignId: campaign.id,
          date: formatted.date,
          spend: formatted.spend,
          impressions: formatted.impressions,
          clicks: formatted.clicks,
          conversions: formatted.conversions,
        });
      }
      synced++;
    }

    await completeSyncLog(syncLog.id, "completed", synced);
    console.log(`[Sync] Google Ads: synced ${synced} campaign stats for tenant ${tenantId}`);
    return { synced };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await completeSyncLog(syncLog.id, "error", 0, message);
    console.error(`[Sync] Google Ads error for tenant ${tenantId}:`, message);
    return { synced: 0, error: message };
  }
}

export async function syncMetaCampaigns(tenantId: number): Promise<{ synced: number; error?: string }> {
  const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId));
  if (!tenant) return { synced: 0, error: "Tenant not found" };

  const config = getTenantConfig(tenant);
  if (!config?.metaAccessToken || !config?.metaAdAccountId) {
    return { synced: 0, error: "Meta not configured" };
  }

  const syncLog = await logSync(tenantId, "meta", "campaigns", new Date());

  try {
    const endDate = new Date().toISOString().split("T")[0];
    const startDate = new Date(Date.now() - 90 * 86400000).toISOString().split("T")[0];

    const insights = await fetchCampaignInsights(
      { accessToken: config.metaAccessToken, adAccountId: config.metaAdAccountId },
      startDate,
      endDate,
    );
    let synced = 0;

    for (const insight of insights) {
      const formatted = formatMetaInsight(insight);

      let [campaign] = await db.select().from(campaignsTable)
        .where(and(eq(campaignsTable.tenantId, tenantId), eq(campaignsTable.platform, "meta"), eq(campaignsTable.externalId, formatted.externalId)))
        .limit(1);

      if (!campaign) {
        [campaign] = await db.insert(campaignsTable).values({
          tenantId,
          platform: formatted.platform,
          externalId: formatted.externalId,
          name: formatted.name,
          status: formatted.status,
        }).returning();
      }

      const [existingStat] = await db.select().from(campaignDailyStatsTable)
        .where(and(eq(campaignDailyStatsTable.campaignId, campaign.id), eq(campaignDailyStatsTable.date, formatted.date)))
        .limit(1);

      if (existingStat) {
        await db.update(campaignDailyStatsTable)
          .set({ spend: formatted.spend, impressions: formatted.impressions, clicks: formatted.clicks, conversions: formatted.conversions })
          .where(eq(campaignDailyStatsTable.id, existingStat.id));
      } else {
        await db.insert(campaignDailyStatsTable).values({
          campaignId: campaign.id,
          date: formatted.date,
          spend: formatted.spend,
          impressions: formatted.impressions,
          clicks: formatted.clicks,
          conversions: formatted.conversions,
        });
      }
      synced++;
    }

    await completeSyncLog(syncLog.id, "completed", synced);
    console.log(`[Sync] Meta: synced ${synced} campaign stats for tenant ${tenantId}`);
    return { synced };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await completeSyncLog(syncLog.id, "error", 0, message);
    console.error(`[Sync] Meta error for tenant ${tenantId}:`, message);
    return { synced: 0, error: message };
  }
}

let syncTimers: ReturnType<typeof setInterval>[] = [];

export function startSyncScheduler() {
  stopSyncScheduler();

  const jobsSyncInterval = 15 * 60 * 1000;
  const campaignSyncInterval = 60 * 60 * 1000;

  const jobsTimer = setInterval(async () => {
    console.log("[SyncScheduler] ServiceTitan jobs sync PAUSED — integration disabled");
  }, jobsSyncInterval);

  const campaignTimer = setInterval(async () => {
    console.log("[SyncScheduler] Starting campaign spend sync for all tenants");
    const tenants = await db.select().from(tenantsTable).where(eq(tenantsTable.isActive, true));
    for (const tenant of tenants) {
      await syncGoogleAdsCampaigns(tenant.id);
      await syncMetaCampaigns(tenant.id);
    }
  }, campaignSyncInterval);

  const reviewSyncInterval = 6 * 60 * 60 * 1000;
  const reviewTimer = setInterval(async () => {
    console.log("[SyncScheduler] Podium review sync PAUSED — integration disabled");
  }, reviewSyncInterval);

  const callRailSyncInterval = 30 * 60 * 1000;
  const callRailTimer = setInterval(async () => {
    console.log("[SyncScheduler] CallRail sync PAUSED — integration disabled");
  }, callRailSyncInterval);

  syncTimers = [jobsTimer, campaignTimer, reviewTimer, callRailTimer];
  console.log("[SyncScheduler] Started: ST/Podium/CallRail PAUSED, campaigns every 60min");
}

export function stopSyncScheduler() {
  for (const timer of syncTimers) {
    clearInterval(timer);
  }
  syncTimers = [];
}
