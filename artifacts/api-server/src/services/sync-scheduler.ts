import { db, tenantsTable, jobsTable, leadsTable, campaignsTable, campaignDailyStatsTable, integrationSyncLogsTable, soldEstimatesTable, callAttemptsTable, metaAdsTable, metaAdSetsTable, metaAdDailyStatsTable } from "@workspace/db";
import { emitSyncFailureNotification } from "./notifications";
import { eq, and, isNull, isNotNull, sql, desc, or, type SQL } from "drizzle-orm";
import { decryptConfig } from "../lib/encryption";
import { fetchCompletedJobs, formatSTJobForSync, fetchCustomerContactsById, fetchLocationsByIds, formatLocationAddress, fetchInvoices, parseInvoiceData, fetchSoldEstimates, parseEstimateData, resolveEmployeeName, clearEmployeeCache, type STJob, type STInvoice, type STEstimate } from "./integrations/service-titan";
import { fetchCampaignPerformance, formatCampaignRow } from "./integrations/google-ads";
import { MetaAPIService, MetaTokenInvalidError, parseNumericField, parseIntField, sumConversionActions, type MetaAction } from "./integrations/meta";
import { syncPodiumReviews } from "./integrations/podium";
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

export async function matchJobsToLeads(tenantId: number): Promise<{ matched: number }> {
  const unmatchedJobs = await db.select({
    id: jobsTable.id,
    customerPhone: jobsTable.customerPhone,
    customerEmail: jobsTable.customerEmail,
  }).from(jobsTable).where(
    and(
      eq(jobsTable.tenantId, tenantId),
      isNull(jobsTable.leadId),
      or(isNotNull(jobsTable.customerPhone), isNotNull(jobsTable.customerEmail)),
    ),
  );

  if (unmatchedJobs.length === 0) return { matched: 0 };

  let matched = 0;
  for (const job of unmatchedJobs) {
    const matchConditions: SQL[] = [eq(leadsTable.tenantId, tenantId)];

    const orClauses: SQL[] = [];
    if (job.customerPhone) {
      orClauses.push(
        sql`${leadsTable.phone} IS NOT NULL AND ${leadsTable.phone} != '' AND ${leadsTable.phone} = ${job.customerPhone}`,
      );
    }
    if (job.customerEmail) {
      orClauses.push(
        sql`${leadsTable.email} IS NOT NULL AND ${leadsTable.email} != '' AND LOWER(${leadsTable.email}) = LOWER(${job.customerEmail})`,
      );
    }

    if (orClauses.length === 0) continue;

    matchConditions.push(or(...orClauses)!);

    const [lead] = await db.select({ id: leadsTable.id })
      .from(leadsTable)
      .where(and(...matchConditions))
      .orderBy(desc(leadsTable.createdAt))
      .limit(1);

    if (lead) {
      await db.update(jobsTable)
        .set({ leadId: lead.id, updatedAt: new Date() })
        .where(eq(jobsTable.id, job.id));
      matched++;
    }
  }

  console.log(`[LeadMatch] Linked ${matched}/${unmatchedJobs.length} jobs to leads for tenant ${tenantId}`);
  return { matched };
}

export async function syncServiceTitanJobs(tenantId: number): Promise<{ synced: number; error?: string }> {
  const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId));
  if (!tenant) return { synced: 0, error: "Tenant not found" };

  if (tenant.stSyncPaused) {
    return { synced: 0, error: "ServiceTitan sync is paused for this tenant" };
  }

  const config = getTenantConfig(tenant);
  if (!config?.serviceTitanClientId || !config?.serviceTitanClientSecret || !config?.serviceTitanAppKey) {
    const missing = [
      !config?.serviceTitanClientId && "Client ID",
      !config?.serviceTitanClientSecret && "Client Secret",
      !config?.serviceTitanAppKey && "App Key",
    ].filter(Boolean).join(", ");
    const errorMessage = `ServiceTitan not configured (missing: ${missing})`;
    const missingLog = await logSync(tenantId, "service_titan", "jobs", new Date());
    await completeSyncLog(missingLog.id, "error", 0, errorMessage);
    return { synced: 0, error: errorMessage };
  }

  const syncLog = await logSync(tenantId, "service_titan", "jobs", new Date());

  try {
    const stConfig = {
      clientId: config.serviceTitanClientId,
      clientSecret: config.serviceTitanClientSecret,
      tenantId: config.serviceTitanTenantId || tenant.serviceTitanId || "",
      appKey: config.serviceTitanAppKey,
    };

    let synced = 0;

    async function processJobBatch(stJobs: STJob[]) {
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
    }

    await fetchCompletedJobs(stConfig, undefined, processJobBatch);

    await completeSyncLog(syncLog.id, "completed", synced);
    console.log(`[Sync] ServiceTitan: synced ${synced} jobs for tenant ${tenantId}`);

    try {
      await Promise.all([
        enrichCustomerContacts(tenantId, stConfig),
        enrichJobAddresses(tenantId, stConfig),
      ]);
    } catch (err) {
      console.warn(`[Sync] Enrichment failed for tenant ${tenantId}:`, (err as Error).message);
    }

    if (synced > 0) {
      console.log(`[Sync] Running post-sync pipeline for tenant ${tenantId}`);

      try {
        await matchJobsToLeads(tenantId);
      } catch (err) {
        console.error(`[Sync] Post-sync lead matching failed for tenant ${tenantId}:`, (err as Error).message);
      }

      try {
        await runReconciliation(tenantId, "scheduled");
      } catch (err) {
        console.error(`[Sync] Post-sync reconciliation failed for tenant ${tenantId}:`, (err as Error).message);
      }

      try {
        await syncServiceTitanInvoices(tenantId);
      } catch (err) {
        console.error(`[Sync] Post-sync invoice sync failed for tenant ${tenantId}:`, (err as Error).message);
      }
    }

    return { synced };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await completeSyncLog(syncLog.id, "error", 0, message);
    console.error(`[Sync] ServiceTitan error for tenant ${tenantId}:`, message);
    try { await emitSyncFailureNotification(tenantId, "service_titan", message); } catch {}
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
  const hasRefreshCredentials = !!(config?.googleAdsRefreshToken && config?.googleAdsClientId && config?.googleAdsClientSecret);
  let missingMessage: string | null = null;
  if (!config?.googleAdsCustomerId) {
    missingMessage = "Google Ads not configured (missing Customer ID)";
  } else if (!config.googleAdsDeveloperToken) {
    missingMessage = "Google Ads not configured (missing Developer Token)";
  } else if (!config.googleAdsApiKey && !hasRefreshCredentials) {
    missingMessage = "Google Ads not configured (need either an Access Token or OAuth Refresh Token + Client ID + Client Secret)";
  }
  if (missingMessage) {
    const missingLog = await logSync(tenantId, "google_ads", "campaigns", new Date());
    await completeSyncLog(missingLog.id, "error", 0, missingMessage);
    return { synced: 0, error: missingMessage };
  }

  const syncLog = await logSync(tenantId, "google_ads", "campaigns", new Date());

  try {
    const endDate = new Date().toISOString().split("T")[0];
    const startDate = new Date(Date.now() - 90 * 86400000).toISOString().split("T")[0];

    const gaConfig = {
      developerToken: config!.googleAdsDeveloperToken || "",
      accessToken: config!.googleAdsApiKey || "",
      refreshToken: config!.googleAdsRefreshToken,
      clientId: config!.googleAdsClientId,
      clientSecret: config!.googleAdsClientSecret,
      customerId: config!.googleAdsCustomerId!,
      loginCustomerId: config!.googleAdsLoginCustomerId,
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
    try { await emitSyncFailureNotification(tenantId, "google_ads", message); } catch {}
    return { synced: 0, error: message };
  }
}

export async function syncMetaCampaigns(tenantId: number): Promise<{ synced: number; error?: string }> {
  const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId));
  if (!tenant) return { synced: 0, error: "Tenant not found" };

  if (tenant.metaNeedsReconnect) {
    const errorMessage = `Meta needs reconnect: ${tenant.metaReconnectReason || "access token expired"}`;
    const skippedLog = await logSync(tenantId, "meta", "campaigns", new Date());
    await completeSyncLog(skippedLog.id, "error", 0, errorMessage);
    return { synced: 0, error: errorMessage };
  }

  const config = getTenantConfig(tenant);
  if (!config?.metaAccessToken || !config?.metaAdAccountId) {
    const missing = [
      !config?.metaAccessToken && "Access Token (run Meta OAuth)",
      !config?.metaAdAccountId && "Ad Account selection",
    ].filter(Boolean).join(", ");
    const errorMessage = `Meta not configured (missing: ${missing})`;
    const missingLog = await logSync(tenantId, "meta", "campaigns", new Date());
    await completeSyncLog(missingLog.id, "error", 0, errorMessage);
    return { synced: 0, error: errorMessage };
  }

  const syncLog = await logSync(tenantId, "meta", "campaigns", new Date());
  const adAccountId = config.metaAdAccountId.startsWith("act_") ? config.metaAdAccountId : `act_${config.metaAdAccountId}`;
  const accountIdNoPrefix = adAccountId.replace(/^act_/, "");

  // Per-tenant transaction-scoped advisory lock prevents concurrent Meta syncs
  // (manual + scheduler overlap) from racing on unique-index upserts.
  // 0x4d455441 = 'META' magic number to namespace this lock from other features.
  const lockResult = await db.execute(sql`SELECT pg_try_advisory_lock(${0x4d455441}, ${tenantId}) AS got`);
  const gotLock = (lockResult.rows[0] as { got: boolean } | undefined)?.got === true;
  if (!gotLock) {
    const errorMessage = "Another Meta sync is already running for this tenant";
    await completeSyncLog(syncLog.id, "error", 0, errorMessage);
    return { synced: 0, error: errorMessage };
  }

  try {
    const endDate = new Date().toISOString().split("T")[0];
    // Refetch last 30 days every run to catch attribution back-fills.
    const startDate = new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0];

    const svc = new MetaAPIService({
      accessToken: config.metaAccessToken,
      adAccountId,
      pixelId: config.metaPixelId,
    });

    // Use account currency if known (from meta_ad_accounts).
    let currency: string | undefined;
    try {
      const { metaAdAccountsTable } = await import("@workspace/db");
      const [acct] = await db.select().from(metaAdAccountsTable)
        .where(and(eq(metaAdAccountsTable.tenantId, tenantId), eq(metaAdAccountsTable.accountId, accountIdNoPrefix)))
        .limit(1);
      currency = acct?.currency;
    } catch {}

    // Fetch ad-set + ad metadata so we can persist names/statuses/budgets.
    const [adSets, ads, insights] = await Promise.all([
      svc.fetchAdSets().catch((e) => { throw e; }),
      svc.fetchAds().catch((e) => { throw e; }),
      svc.fetchAdDailyInsights(startDate, endDate),
    ]);

    // Batched upsert: ad sets (single statement, ON CONFLICT)
    if (adSets.length > 0) {
      const adSetRows = adSets.map((a) => ({
        tenantId,
        adAccountId: accountIdNoPrefix,
        externalId: a.id,
        campaignExternalId: a.campaign_id ?? null,
        name: a.name || "",
        effectiveStatus: a.effective_status ?? null,
        dailyBudgetCents: a.daily_budget ? parseIntField(a.daily_budget) : null,
      }));
      await db.insert(metaAdSetsTable).values(adSetRows)
        .onConflictDoUpdate({
          target: [metaAdSetsTable.tenantId, metaAdSetsTable.externalId],
          set: {
            adAccountId: sql`excluded.ad_account_id`,
            campaignExternalId: sql`excluded.campaign_external_id`,
            name: sql`excluded.name`,
            effectiveStatus: sql`excluded.effective_status`,
            dailyBudgetCents: sql`excluded.daily_budget_cents`,
            updatedAt: sql`now()`,
          },
        });
    }

    // Batched upsert: ads
    if (ads.length > 0) {
      const adRows = ads.map((a) => ({
        tenantId,
        adAccountId: accountIdNoPrefix,
        externalId: a.id,
        adSetExternalId: a.adset_id ?? null,
        campaignExternalId: a.campaign_id ?? null,
        name: a.name || "",
        effectiveStatus: a.effective_status ?? null,
        creativeId: a.creative?.id ?? null,
      }));
      // Chunk to avoid PG bind-parameter limit (8 cols × 8000 = 64000 < 65535)
      for (let i = 0; i < adRows.length; i += 1000) {
        await db.insert(metaAdsTable).values(adRows.slice(i, i + 1000))
          .onConflictDoUpdate({
            target: [metaAdsTable.tenantId, metaAdsTable.externalId],
            set: {
              adAccountId: sql`excluded.ad_account_id`,
              adSetExternalId: sql`excluded.ad_set_external_id`,
              campaignExternalId: sql`excluded.campaign_external_id`,
              name: sql`excluded.name`,
              effectiveStatus: sql`excluded.effective_status`,
              creativeId: sql`excluded.creative_id`,
              updatedAt: sql`now()`,
            },
          });
      }
    }

    // Aggregate per-ad rows → per-campaign-per-day for backwards-compatible
    // dashboards on `campaign_daily_stats`. Keep raw per-ad rows in
    // `meta_ad_daily_stats`.
    interface CampaignDayBucket {
      campaignId: string;
      campaignName: string;
      date: string;
      spend: number;
      impressions: number;
      clicks: number;
      conversions: number;
      actionsTotals: Map<string, number>;
    }
    const campaignBuckets = new Map<string, CampaignDayBucket>();
    const adDailyRows: Array<typeof metaAdDailyStatsTable.$inferInsert> = [];

    for (const row of insights) {
      const adId = row.ad_id;
      if (!adId) continue;

      const date = row.date_start;
      const spend = parseNumericField(row.spend);
      const impressions = parseIntField(row.impressions);
      const clicks = parseIntField(row.clicks);
      const actions: MetaAction[] = row.actions || [];
      const conversions = sumConversionActions(actions);

      adDailyRows.push({
        tenantId,
        adAccountId: accountIdNoPrefix,
        adExternalId: adId,
        campaignExternalId: row.campaign_id,
        adSetExternalId: row.adset_id ?? null,
        date,
        spend,
        impressions,
        clicks,
        conversions,
        currency: currency ?? null,
        actionsJson: actions,
      });

      const bucketKey = `${row.campaign_id}|${date}`;
      let bucket = campaignBuckets.get(bucketKey);
      if (!bucket) {
        bucket = {
          campaignId: row.campaign_id,
          campaignName: row.campaign_name || row.campaign_id,
          date,
          spend: 0, impressions: 0, clicks: 0, conversions: 0,
          actionsTotals: new Map(),
        };
        campaignBuckets.set(bucketKey, bucket);
      }
      bucket.spend += spend;
      bucket.impressions += impressions;
      bucket.clicks += clicks;
      bucket.conversions += conversions;
      for (const a of actions) {
        bucket.actionsTotals.set(a.action_type, (bucket.actionsTotals.get(a.action_type) || 0) + parseIntField(a.value));
      }
    }

    // Batched upsert: per-ad daily stats (12 cols × 5000 = 60000 < 65535)
    for (let i = 0; i < adDailyRows.length; i += 1000) {
      const chunk = adDailyRows.slice(i, i + 1000);
      if (chunk.length === 0) continue;
      await db.insert(metaAdDailyStatsTable).values(chunk)
        .onConflictDoUpdate({
          target: [metaAdDailyStatsTable.tenantId, metaAdDailyStatsTable.adExternalId, metaAdDailyStatsTable.date],
          set: {
            adAccountId: sql`excluded.ad_account_id`,
            campaignExternalId: sql`excluded.campaign_external_id`,
            adSetExternalId: sql`excluded.ad_set_external_id`,
            spend: sql`excluded.spend`,
            impressions: sql`excluded.impressions`,
            clicks: sql`excluded.clicks`,
            conversions: sql`excluded.conversions`,
            currency: sql`excluded.currency`,
            actionsJson: sql`excluded.actions_json`,
          },
        });
    }
    const perAdSynced = adDailyRows.length;

    // Upsert campaigns: bulk insert with ON CONFLICT requires a unique
    // constraint on (tenant_id, platform, external_id). The legacy
    // `campaigns` table doesn't have one, so for the (typically small)
    // number of distinct campaigns per tenant we keep a per-campaign
    // upsert here — bounded by campaign count, not ad-day rows.
    const campaignIdByExternal = new Map<string, number>();
    const distinctCampaigns = new Map<string, string>();
    for (const b of campaignBuckets.values()) distinctCampaigns.set(b.campaignId, b.campaignName);

    for (const [extId, name] of distinctCampaigns.entries()) {
      let [campaign] = await db.select().from(campaignsTable)
        .where(and(
          eq(campaignsTable.tenantId, tenantId),
          eq(campaignsTable.platform, "meta"),
          eq(campaignsTable.externalId, extId),
        )).limit(1);
      if (!campaign) {
        [campaign] = await db.insert(campaignsTable).values({
          tenantId, platform: "meta", externalId: extId, name,
          status: "active", currency: currency ?? null, metaAdAccountId: accountIdNoPrefix,
        }).returning();
      } else if (campaign.name !== name || campaign.currency !== (currency ?? null) || campaign.metaAdAccountId !== accountIdNoPrefix) {
        await db.update(campaignsTable)
          .set({ name, currency: currency ?? null, metaAdAccountId: accountIdNoPrefix })
          .where(eq(campaignsTable.id, campaign.id));
      }
      campaignIdByExternal.set(extId, campaign.id);
    }

    // Batched upsert: campaign_daily_stats
    const statRows: Array<typeof campaignDailyStatsTable.$inferInsert> = [];
    for (const bucket of campaignBuckets.values()) {
      const campaignId = campaignIdByExternal.get(bucket.campaignId);
      if (!campaignId) continue;
      const actionsObj: Record<string, number> = {};
      for (const [k, v] of bucket.actionsTotals.entries()) actionsObj[k] = v;
      statRows.push({
        campaignId, date: bucket.date,
        spend: bucket.spend, impressions: bucket.impressions,
        clicks: bucket.clicks, conversions: bucket.conversions,
        actionsJson: actionsObj, currency: currency ?? null,
      });
    }
    for (let i = 0; i < statRows.length; i += 1000) {
      const chunk = statRows.slice(i, i + 1000);
      if (chunk.length === 0) continue;
      await db.insert(campaignDailyStatsTable).values(chunk)
        .onConflictDoUpdate({
          target: [campaignDailyStatsTable.campaignId, campaignDailyStatsTable.date],
          set: {
            spend: sql`excluded.spend`,
            impressions: sql`excluded.impressions`,
            clicks: sql`excluded.clicks`,
            conversions: sql`excluded.conversions`,
            actionsJson: sql`excluded.actions_json`,
            currency: sql`excluded.currency`,
          },
        });
    }

    await db.update(tenantsTable)
      .set({ metaLastSyncedAt: new Date(), metaNeedsReconnect: false, metaReconnectReason: null, updatedAt: new Date() })
      .where(eq(tenantsTable.id, tenantId));

    await completeSyncLog(syncLog.id, "completed", perAdSynced);
    console.log(`[Sync] Meta tenant ${tenantId}: ${perAdSynced} ad-day rows, ${campaignBuckets.size} campaign-day rollups`);
    return { synced: perAdSynced };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof MetaTokenInvalidError) {
      await db.update(tenantsTable)
        .set({ metaNeedsReconnect: true, metaReconnectReason: message, updatedAt: new Date() })
        .where(eq(tenantsTable.id, tenantId));
      console.error(`[Sync] Meta tenant ${tenantId} token expired — flagged for reconnect`);
    }
    await completeSyncLog(syncLog.id, "error", 0, message);
    console.error(`[Sync] Meta error for tenant ${tenantId}:`, message);
    try { await emitSyncFailureNotification(tenantId, "meta", message); } catch {}
    return { synced: 0, error: message };
  } finally {
    try { await db.execute(sql`SELECT pg_advisory_unlock(${0x4d455441}, ${tenantId})`); } catch {}
  }
}

export async function syncServiceTitanInvoices(tenantId: number): Promise<{ synced: number; error?: string }> {
  const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId));
  if (!tenant) return { synced: 0, error: "Tenant not found" };

  if (tenant.stSyncPaused) {
    return { synced: 0, error: "ServiceTitan sync is paused for this tenant" };
  }

  const config = getTenantConfig(tenant);
  if (!config?.serviceTitanClientId || !config?.serviceTitanClientSecret || !config?.serviceTitanAppKey) {
    const missing = [
      !config?.serviceTitanClientId && "Client ID",
      !config?.serviceTitanClientSecret && "Client Secret",
      !config?.serviceTitanAppKey && "App Key",
    ].filter(Boolean).join(", ");
    const errorMessage = `ServiceTitan not configured (missing: ${missing})`;
    const missingLog = await logSync(tenantId, "service_titan", "invoices", new Date());
    await completeSyncLog(missingLog.id, "error", 0, errorMessage);
    return { synced: 0, error: errorMessage };
  }

  const [lastSuccessfulSync] = await db.select({ completedAt: integrationSyncLogsTable.completedAt })
    .from(integrationSyncLogsTable)
    .where(and(
      eq(integrationSyncLogsTable.tenantId, tenantId),
      eq(integrationSyncLogsTable.integration, "service_titan"),
      eq(integrationSyncLogsTable.syncType, "invoices"),
      eq(integrationSyncLogsTable.status, "completed"),
    ))
    .orderBy(desc(integrationSyncLogsTable.completedAt))
    .limit(1);

  const modifiedOnOrAfter = lastSuccessfulSync?.completedAt?.toISOString() ?? undefined;

  const syncLog = await logSync(tenantId, "service_titan", "invoices", new Date());

  try {
    const stConfig = {
      clientId: config.serviceTitanClientId,
      clientSecret: config.serviceTitanClientSecret,
      tenantId: config.serviceTitanTenantId || tenant.serviceTitanId || "",
      appKey: config.serviceTitanAppKey,
    };

    let synced = 0;

    async function processInvoiceBatch(invoices: STInvoice[]) {
      const jobInvoiceMap = new Map<string, typeof invoices>();
      for (const invoice of invoices) {
        if (!invoice.job) continue;
        const jobId = String(invoice.job.id);
        const existing = jobInvoiceMap.get(jobId) || [];
        existing.push(invoice);
        jobInvoiceMap.set(jobId, existing);
      }

      for (const [stJobId, jobInvoices] of jobInvoiceMap.entries()) {
        const jobIdHash = hashStJobId(stJobId);

        const [existingJob] = await db.select({ id: jobsTable.id, stInvoiceId: jobsTable.stInvoiceId })
          .from(jobsTable)
          .where(and(
            eq(jobsTable.tenantId, tenantId),
            sql`(${jobsTable.stJobId} = ${stJobId} OR ${jobsTable.stJobIdHash} = ${jobIdHash})`,
          ))
          .limit(1);

        if (!existingJob) continue;

        const sorted = jobInvoices.sort((a, b) => {
          const dateA = a.invoiceDate ? new Date(a.invoiceDate).getTime() : 0;
          const dateB = b.invoiceDate ? new Date(b.invoiceDate).getTime() : 0;
          return dateB - dateA;
        });

        let totalInvoiceAmount = 0;
        let totalRebate = 0;
        let totalPaid = 0;
        let totalBalance = 0;
        let latestPaidOn: Date | null = null;

        for (const inv of sorted) {
          const parsed = parseInvoiceData(inv);
          totalInvoiceAmount += parsed.invoiceTotal;
          totalRebate += parsed.invoiceRebateAmount;
          totalPaid += parsed.invoicePaidAmount;
          totalBalance += parsed.invoiceBalance;
          if (parsed.invoicePaidOn && (!latestPaidOn || parsed.invoicePaidOn > latestPaidOn)) {
            latestPaidOn = parsed.invoicePaidOn;
          }
        }

        const latestInvoice = parseInvoiceData(sorted[0]);

        await db.update(jobsTable)
          .set({
            hasInvoice: true,
            invoiceTotal: totalInvoiceAmount,
            invoiceRebateAmount: totalRebate,
            invoicePaidAmount: totalPaid > 0 ? totalPaid : 0,
            invoiceBalance: totalBalance,
            stInvoiceId: latestInvoice.stInvoiceId,
            invoiceDate: latestInvoice.invoiceDate,
            invoicePaidOn: latestPaidOn,
            updatedAt: new Date(),
          })
          .where(eq(jobsTable.id, existingJob.id));
        synced++;
      }
    }

    await fetchInvoices(stConfig, modifiedOnOrAfter, processInvoiceBatch);

    await completeSyncLog(syncLog.id, "completed", synced);
    console.log(`[Sync] ServiceTitan invoices: synced ${synced} invoices for tenant ${tenantId}`);
    return { synced };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await completeSyncLog(syncLog.id, "error", 0, message);
    console.error(`[Sync] ServiceTitan invoices error for tenant ${tenantId}:`, message);
    try { await emitSyncFailureNotification(tenantId, "service_titan", message); } catch {}
    return { synced: 0, error: message };
  }
}

export async function syncServiceTitanEstimates(tenantId: number): Promise<{ synced: number; error?: string }> {
  const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId));
  if (!tenant) return { synced: 0, error: "Tenant not found" };

  if (tenant.stSyncPaused) {
    return { synced: 0, error: "ServiceTitan sync is paused for this tenant" };
  }

  const config = getTenantConfig(tenant);
  if (!config?.serviceTitanClientId || !config?.serviceTitanClientSecret || !config?.serviceTitanAppKey) {
    const missing = [
      !config?.serviceTitanClientId && "Client ID",
      !config?.serviceTitanClientSecret && "Client Secret",
      !config?.serviceTitanAppKey && "App Key",
    ].filter(Boolean).join(", ");
    const errorMessage = `ServiceTitan not configured (missing: ${missing})`;
    const missingLog = await logSync(tenantId, "service_titan", "estimates", new Date());
    await completeSyncLog(missingLog.id, "error", 0, errorMessage);
    return { synced: 0, error: errorMessage };
  }

  const [lastSuccessfulSync] = await db.select({ completedAt: integrationSyncLogsTable.completedAt })
    .from(integrationSyncLogsTable)
    .where(and(
      eq(integrationSyncLogsTable.tenantId, tenantId),
      eq(integrationSyncLogsTable.integration, "service_titan"),
      eq(integrationSyncLogsTable.syncType, "estimates"),
      eq(integrationSyncLogsTable.status, "completed"),
    ))
    .orderBy(desc(integrationSyncLogsTable.completedAt))
    .limit(1);

  const modifiedOnOrAfter = lastSuccessfulSync?.completedAt?.toISOString() ?? undefined;

  const syncLog = await logSync(tenantId, "service_titan", "estimates", new Date());

  try {
    const stConfig = {
      clientId: config.serviceTitanClientId,
      clientSecret: config.serviceTitanClientSecret,
      tenantId: config.serviceTitanTenantId || tenant.serviceTitanId || "",
      appKey: config.serviceTitanAppKey,
    };

    let synced = 0;
    clearEmployeeCache();

    const [fallbackUser] = await db.select({ id: sql<number>`id` })
      .from(sql`users`)
      .where(sql`tenant_id = ${tenantId}`)
      .limit(1);
    const fallbackUserId = fallbackUser?.id ?? 1;

    async function processEstimateBatch(estimates: STEstimate[]) {
      for (const estimate of estimates) {
        const parsed = parseEstimateData(estimate);
        if (!parsed.stEstimateId) continue;

        const [existing] = await db.select({ id: soldEstimatesTable.id, leadId: soldEstimatesTable.leadId })
          .from(soldEstimatesTable)
          .where(and(
            eq(soldEstimatesTable.tenantId, tenantId),
            eq(soldEstimatesTable.stEstimateId, parsed.stEstimateId),
          ))
          .limit(1);

        let soldByName: string | null = null;
        if (parsed.soldByEmployeeId) {
          soldByName = await resolveEmployeeName(stConfig, parsed.soldByEmployeeId);
        }

        let matchedJobId: number | null = null;
        let matchedLeadId: number | null = null;

        if (parsed.stJobId) {
          const jobIdHash = hashStJobId(parsed.stJobId);
          const [matchedJob] = await db.select({ id: jobsTable.id, leadId: jobsTable.leadId })
            .from(jobsTable)
            .where(and(
              eq(jobsTable.tenantId, tenantId),
              sql`(${jobsTable.stJobId} = ${parsed.stJobId} OR ${jobsTable.stJobIdHash} = ${jobIdHash})`,
            ))
            .limit(1);
          if (matchedJob) {
            matchedJobId = matchedJob.id;
            matchedLeadId = matchedJob.leadId;
          }
        }

        const wasUnlinked = existing && !existing.leadId;
        const nowLinked = !!matchedLeadId;

        if (existing) {
          await db.update(soldEstimatesTable)
            .set({
              jobId: matchedJobId,
              leadId: matchedLeadId,
              stJobId: parsed.stJobId,
              soldByName,
              soldByStEmployeeId: parsed.soldByEmployeeId,
              soldOn: parsed.soldOn,
              subtotal: parsed.subtotal,
              rebateAmount: parsed.rebateAmount,
              totalAmount: parsed.totalAmount,
              updatedAt: new Date(),
            })
            .where(eq(soldEstimatesTable.id, existing.id));

          if (wasUnlinked && nowLinked && matchedLeadId) {
            const dollarStr = `$${(parsed.totalAmount || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
            const salesperson = soldByName ? ` (Sold by: ${soldByName})` : "";
            const noteText = `Contract signed — ${dollarStr}${salesperson}`;
            const [lead] = await db.select({ assignedCsrId: leadsTable.assignedCsrId })
              .from(leadsTable).where(eq(leadsTable.id, matchedLeadId)).limit(1);
            const userId = lead?.assignedCsrId ?? fallbackUserId;

            await db.insert(callAttemptsTable).values({
              leadId: matchedLeadId,
              userId,
              actionType: "system",
              method: "system",
              outcome: "system",
              platform: "service_titan",
              notes: noteText,
              attemptedAt: parsed.soldOn ?? new Date(),
            });
          }
        } else {
          await db.insert(soldEstimatesTable).values({
            tenantId,
            leadId: matchedLeadId,
            jobId: matchedJobId,
            stEstimateId: parsed.stEstimateId,
            stJobId: parsed.stJobId,
            soldByName,
            soldByStEmployeeId: parsed.soldByEmployeeId,
            soldOn: parsed.soldOn,
            subtotal: parsed.subtotal,
            rebateAmount: parsed.rebateAmount,
            totalAmount: parsed.totalAmount,
          });

          if (matchedLeadId) {
            const dollarStr = `$${(parsed.totalAmount || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
            const salesperson = soldByName ? ` (Sold by: ${soldByName})` : "";
            const noteText = `Contract signed — ${dollarStr}${salesperson}`;
            const [lead] = await db.select({ assignedCsrId: leadsTable.assignedCsrId })
              .from(leadsTable).where(eq(leadsTable.id, matchedLeadId)).limit(1);
            const userId = lead?.assignedCsrId ?? fallbackUserId;

            await db.insert(callAttemptsTable).values({
              leadId: matchedLeadId,
              userId,
              actionType: "system",
              method: "system",
              outcome: "system",
              platform: "service_titan",
              notes: noteText,
              attemptedAt: parsed.soldOn ?? new Date(),
            });
          }
        }

        if (matchedLeadId) {
          await db.update(leadsTable)
            .set({ hasSoldEstimate: true, updatedAt: new Date() })
            .where(eq(leadsTable.id, matchedLeadId));
        }

        synced++;
      }
    }

    await fetchSoldEstimates(stConfig, modifiedOnOrAfter, processEstimateBatch);

    await completeSyncLog(syncLog.id, "completed", synced);
    console.log(`[Sync] ServiceTitan estimates: synced ${synced} sold estimates for tenant ${tenantId}`);
    return { synced };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await completeSyncLog(syncLog.id, "error", 0, message);
    console.error(`[Sync] ServiceTitan estimates error for tenant ${tenantId}:`, message);
    try { await emitSyncFailureNotification(tenantId, "service_titan", message); } catch {}
    return { synced: 0, error: message };
  }
}

let syncTimers: ReturnType<typeof setInterval>[] = [];

export function startSyncScheduler() {
  stopSyncScheduler();

  const jobsSyncInterval = 15 * 60 * 1000;
  const campaignSyncInterval = 60 * 60 * 1000;

  const jobsTimer = setInterval(async () => {
    console.log("[SyncScheduler] Starting ServiceTitan jobs sync for all tenants");
    const tenants = await db.select().from(tenantsTable).where(eq(tenantsTable.isActive, true));
    for (const tenant of tenants) {
      await syncServiceTitanJobs(tenant.id);
    }
  }, jobsSyncInterval);

  const campaignTimer = setInterval(async () => {
    console.log("[SyncScheduler] Starting Google Ads campaign sync for all tenants");
    const tenants = await db.select().from(tenantsTable).where(eq(tenantsTable.isActive, true));
    for (const tenant of tenants) {
      await syncGoogleAdsCampaigns(tenant.id);
    }
  }, campaignSyncInterval);

  // Meta sync runs nightly at 1 AM Eastern (configurable via META_SYNC_HOUR_ET).
  // Per-tenant 10-second sleep keeps us well under Meta's per-app rate limits
  // even with hundreds of tenants. Scales linearly: 100 tenants = ~17 minutes.
  const metaSyncHourEt = Number(process.env.META_SYNC_HOUR_ET || "1");
  const metaPerTenantSleepMs = Number(process.env.META_PER_TENANT_SLEEP_MS || "10000");
  let lastMetaSyncDateKey = "";
  const metaTimer = setInterval(async () => {
    const nowEt = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
    const dateKey = nowEt.toISOString().slice(0, 10);
    if (nowEt.getHours() !== metaSyncHourEt) return;
    if (dateKey === lastMetaSyncDateKey) return; // already ran today
    lastMetaSyncDateKey = dateKey;

    console.log(`[SyncScheduler] Starting nightly Meta sync (ET hour=${metaSyncHourEt}, per-tenant sleep=${metaPerTenantSleepMs}ms)`);
    const tenants = await db.select().from(tenantsTable).where(eq(tenantsTable.isActive, true));
    for (const tenant of tenants) {
      try {
        await syncMetaCampaigns(tenant.id);
      } catch (err) {
        console.error(`[SyncScheduler] Meta sync failed for tenant ${tenant.id}:`, err);
      }
      await new Promise((r) => setTimeout(r, metaPerTenantSleepMs));
    }
    console.log(`[SyncScheduler] Nightly Meta sync complete (${tenants.length} tenants)`);
  }, 5 * 60 * 1000); // check every 5 minutes whether the trigger hour has arrived

  const invoiceSyncInterval = 15 * 60 * 1000;
  const invoiceTimer = setInterval(async () => {
    console.log("[SyncScheduler] Starting ServiceTitan invoice + estimates sync for all tenants");
    const tenants = await db.select().from(tenantsTable).where(eq(tenantsTable.isActive, true));
    for (const tenant of tenants) {
      await syncServiceTitanInvoices(tenant.id);
      await syncServiceTitanEstimates(tenant.id);
    }
  }, invoiceSyncInterval);

  const reviewSyncInterval = 6 * 60 * 60 * 1000;
  const reviewTimer = setInterval(async () => {
    console.log("[SyncScheduler] Podium review sync PAUSED — integration disabled");
  }, reviewSyncInterval);

  // CallRail intake is webhook-only (POST /api/webhooks/callrail/:tenantId).
  // The previous polling backstop was a permanent no-op timer; it has been
  // removed. If CallRail webhooks ever need a polling safety net,
  // re-enable syncCallRailCalls here on a real interval.

  syncTimers = [jobsTimer, campaignTimer, metaTimer, invoiceTimer, reviewTimer];
  console.log(`[SyncScheduler] Started: ST jobs 15min, Google Ads 60min, Meta nightly @${metaSyncHourEt}:00 ET, invoices+estimates 15min, Podium PAUSED, CallRail webhook-only`);
}

export function stopSyncScheduler() {
  for (const timer of syncTimers) {
    clearInterval(timer);
  }
  syncTimers = [];
}
