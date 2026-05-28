import { db, tenantsTable, jobsTable, leadsTable, campaignsTable, campaignDailyStatsTable, integrationSyncLogsTable, soldEstimatesTable, callAttemptsTable, metaAdsTable, metaAdSetsTable, metaAdDailyStatsTable } from "@workspace/db";
import { emitSyncFailureNotification, emitSyncCatchupNotification } from "./notifications";
import { eq, and, isNull, isNotNull, sql, desc, or, type SQL } from "drizzle-orm";
import { decryptConfig } from "../lib/encryption";
import { fetchCompletedJobs, formatSTJobForSync, fetchCustomerContactsById, fetchLocationsByIds, formatLocationAddress, fetchInvoices, parseInvoiceData, fetchSoldEstimates, parseEstimateData, resolveEmployeeName, clearEmployeeCache, compileRebatePatterns, DEFAULT_REBATE_LABELS, type STJob, type STInvoice, type STEstimate } from "./integrations/service-titan";
import { fetchCampaignPerformance, formatCampaignRow } from "./integrations/google-ads";
import { MetaAPIService, MetaTokenInvalidError, parseNumericField, parseIntField, sumConversionActions, type MetaAction } from "./integrations/meta";
import { syncPodiumReviews } from "./integrations/podium";
import { runReconciliation } from "./reconciliation";
import { normalizePhone, phoneMatchesSql } from "../lib/phone-utils";
import { classifyBackfillError } from "./backfill-status-format";
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

/**
 * Resolves the compiled rebate label patterns for a tenant. Reads the
 * staff-editable list from `tenant.revenueConfig.rebateLabels`, falling back to
 * the seeded defaults (ETO, Energy Trust, ODEE) when the tenant has not
 * configured its own list. Used when parsing invoices/estimates so the rebate
 * add-back logic is configurable without code changes.
 */
function getTenantRebatePatterns(tenant: typeof tenantsTable.$inferSelect): RegExp[] {
  const config = (tenant.revenueConfig || {}) as { rebateLabels?: unknown };
  const labels = Array.isArray(config.rebateLabels)
    ? config.rebateLabels.filter((l): l is string => typeof l === "string" && l.trim().length > 0)
    : null;
  return compileRebatePatterns(labels && labels.length > 0 ? labels : DEFAULT_REBATE_LABELS);
}

async function logSync(
  tenantId: number,
  integration: string,
  syncType: string,
  startedAt: Date,
  options?: { triggeredBySyncLogId?: number | null },
) {
  const [log] = await db.insert(integrationSyncLogsTable).values({
    tenantId,
    integration,
    syncType,
    status: "running",
    startedAt,
    triggeredBySyncLogId: options?.triggeredBySyncLogId ?? null,
  }).returning();
  return log;
}

async function completeSyncLog(logId: number, status: string, recordsProcessed: number, errorMessage?: string) {
  // On terminal status, classify the error message into a stable error_code
  // so consumers (Settings panel) don't have to regex-parse the text. Empty
  // / null messages yield a null code. The classifier is shared with the
  // route's fallback path so legacy rows still display the same friendly
  // copy.
  const code = status === "error" ? classifyBackfillError(errorMessage)?.code ?? null : null;
  await db.update(integrationSyncLogsTable)
    .set({
      status,
      recordsProcessed,
      completedAt: new Date(),
      errorMessage: errorMessage || null,
      errorCode: code,
      // Clear in-flight progress columns so a finished row doesn't keep
      // showing the last chunk window / total in the UI.
      progressCurrentChunk: null,
      progressTotalChunks: null,
      progressWindowStart: null,
      progressWindowEnd: null,
      progressTotalRecords: null,
    })
    .where(eq(integrationSyncLogsTable.id, logId));
}

/**
 * Record in-flight chunk progress for a backfill run. Writes to dedicated
 * columns instead of stuffing a `chunk N/M: …` string into `errorMessage`
 * (Task #395). `errorMessage` is cleared so any prior partial-failure text
 * doesn't linger across chunk boundaries.
 */
async function updateSyncLogChunkProgress(
  logId: number,
  recordsProcessed: number,
  currentChunk: number,
  totalChunks: number,
  windowStart: string,
  windowEnd: string,
) {
  await db.update(integrationSyncLogsTable)
    .set({
      recordsProcessed,
      progressCurrentChunk: currentChunk,
      progressTotalChunks: totalChunks,
      progressWindowStart: windowStart,
      progressWindowEnd: windowEnd,
      errorMessage: null,
      errorCode: null,
      partial: false,
    })
    .where(eq(integrationSyncLogsTable.id, logId));
}

/**
 * Record in-flight row progress for a running sync log without any chunk
 * metadata. Used by the full re-sync (revenue recompute) path so the
 * Settings panel can poll `recordsProcessed` and show live progress while
 * invoices / estimates are being reprocessed batch-by-batch. We don't touch
 * the chunk columns here — those are reserved for windowed backfills.
 */
async function updateSyncLogRecords(logId: number, recordsProcessed: number) {
  await db.update(integrationSyncLogsTable)
    .set({ recordsProcessed })
    .where(eq(integrationSyncLogsTable.id, logId));
}

/**
 * Record the estimated total record count for a non-chunked progress run
 * (full re-sync / revenue recompute). Captured once from the upstream
 * total-count header so the Settings panel can render a percent-complete bar
 * by dividing `recordsProcessed` against this total. Used only by the full
 * re-sync path — windowed backfills report progress via the chunk columns.
 */
async function updateSyncLogTotalRecords(logId: number, totalRecords: number) {
  await db.update(integrationSyncLogsTable)
    .set({ progressTotalRecords: totalRecords })
    .where(eq(integrationSyncLogsTable.id, logId));
}

/**
 * Record a partial-failure mid-run: a later chunk threw, but some rows
 * already landed. Writes the inner upstream message into `errorMessage`
 * (no `partial:` prefix anymore — `partial` is now a real boolean column)
 * along with a classified `errorCode` so the Settings UI gets a stable,
 * typed contract.
 */
async function updateSyncLogPartialFailure(
  logId: number,
  recordsProcessed: number,
  innerMessage: string,
) {
  const code = classifyBackfillError(innerMessage)?.code ?? "unknown";
  await db.update(integrationSyncLogsTable)
    .set({
      recordsProcessed,
      errorMessage: innerMessage,
      errorCode: code,
      partial: true,
    })
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
    const normalizedJobPhone = job.customerPhone ? normalizePhone(job.customerPhone) : "";
    if (normalizedJobPhone) {
      orClauses.push(
        sql`${leadsTable.phone} IS NOT NULL AND ${leadsTable.phone} != '' AND ${phoneMatchesSql(leadsTable.phone, normalizedJobPhone)}`,
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

  // Per-tenant advisory lock (0x5354414e = 'STAN') prevents the 15-min
  // scheduled sync from racing with a manual ServiceTitan backfill on the
  // same SELECT/INSERT job upserts.
  const lockResult = await db.execute(sql`SELECT pg_try_advisory_lock(${0x5354414e}, ${tenantId}) AS got`);
  const gotLock = (lockResult.rows[0] as { got: boolean } | undefined)?.got === true;
  if (!gotLock) {
    const errorMessage = "Another ServiceTitan sync is already running for this tenant";
    await completeSyncLog(syncLog.id, "error", 0, errorMessage);
    return { synced: 0, error: errorMessage };
  }

  // Delta-sync window: only pull jobs modified since the last successful run
  // (with a small overlap buffer so we never miss in-flight edits). Without
  // this the scheduled sync calls `fetchCompletedJobs` with no date filter,
  // which under the raised 500-page safety cap can mean pulling up to 50,000
  // jobs every 15 minutes per tenant — expensive on the ServiceTitan API
  // quota and a guaranteed source of contention with manual backfills.
  // Fall back to a 30-day window for tenants that have never synced (or
  // whose last log was wiped) so we still bound the work to a sane size;
  // operators run an explicit Backfill for full history sweeps.
  const [lastJobsSync] = await db.select({ completedAt: integrationSyncLogsTable.completedAt })
    .from(integrationSyncLogsTable)
    .where(and(
      eq(integrationSyncLogsTable.tenantId, tenantId),
      eq(integrationSyncLogsTable.integration, "service_titan"),
      eq(integrationSyncLogsTable.syncType, "jobs"),
      eq(integrationSyncLogsTable.status, "completed"),
    ))
    .orderBy(desc(integrationSyncLogsTable.completedAt))
    .limit(1);
  const OVERLAP_MS = 30 * 60 * 1000;
  const FALLBACK_WINDOW_MS = 30 * 86400000;
  const sinceMs = lastJobsSync?.completedAt
    ? lastJobsSync.completedAt.getTime() - OVERLAP_MS
    : Date.now() - FALLBACK_WINDOW_MS;
  const modifiedOnOrAfter = new Date(sinceMs).toISOString();

  // Task #567: clamp detection — if the watermark is older than the 30-day
  // rolling fallback window, the in-flight `fetchCompletedJobs` page cap can
  // silently truncate jobs modified during the gap. Stash the missed range
  // and dispatch a backfill from `finally` after releasing the STAN lock
  // (the backfill re-acquires the same lock).
  let autoBackfillDays: number | null = null;
  let autoBackfillReason: string | null = null;
  const ST_ROLLING_WINDOW_DAYS = 30;
  if (lastJobsSync?.completedAt) {
    const gapDays = Math.ceil((Date.now() - lastJobsSync.completedAt.getTime()) / 86400000);
    if (gapDays > ST_ROLLING_WINDOW_DAYS) {
      const missedDays = Math.min(1095, gapDays);
      if (missedDays > 30) {
        autoBackfillDays = missedDays;
        autoBackfillReason = `watermark ${gapDays}d stale > rolling window ${ST_ROLLING_WINDOW_DAYS}d`;
      }
    }
  }

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

    await fetchCompletedJobs(stConfig, modifiedOnOrAfter, processJobBatch);

    await completeSyncLog(syncLog.id, "completed", synced);
    console.log(`[Sync] ServiceTitan: synced ${synced} jobs for tenant ${tenantId} (modifiedOnOrAfter=${modifiedOnOrAfter})`);

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
  } finally {
    try {
      await db.execute(sql`SELECT pg_advisory_unlock(${0x5354414e}, ${tenantId})`);
    } catch (unlockErr) {
      console.error(`[Sync] ServiceTitan tenant ${tenantId}: failed to release advisory lock`, unlockErr);
    }

    // Task #567: dispatch the auto-backfill AFTER releasing the STAN lock,
    // since `backfillServiceTitanJobs` re-acquires the same lock. De-dupe
    // against any in-flight `service_titan/backfill` row so a long-running
    // manual or prior auto-enqueued backfill isn't shadowed by a fresh
    // enqueue from a subsequent nightly tick. Fire-and-forget.
    if (autoBackfillDays !== null) {
      try {
        const [inFlight] = await db.select({ id: integrationSyncLogsTable.id })
          .from(integrationSyncLogsTable)
          .where(and(
            eq(integrationSyncLogsTable.tenantId, tenantId),
            eq(integrationSyncLogsTable.integration, "service_titan"),
            eq(integrationSyncLogsTable.syncType, "backfill"),
            eq(integrationSyncLogsTable.status, "running"),
          ))
          .limit(1);
        if (inFlight) {
          console.log(
            `[Sync] ServiceTitan tenant ${tenantId}: nightly clamped (${autoBackfillReason}); skipping auto-backfill — existing service_titan/backfill log ${inFlight.id} still running`,
          );
        } else {
          console.log(
            `[Sync] ServiceTitan tenant ${tenantId}: nightly clamped (${autoBackfillReason}); auto-enqueuing backfillServiceTitanJobs(days=${autoBackfillDays}) linked to sync log ${syncLog.id}`,
          );
          void backfillServiceTitanJobs(tenantId, autoBackfillDays).catch((err) => {
            console.error(
              `[Sync] ServiceTitan tenant ${tenantId}: auto-enqueued backfill failed`,
              err,
            );
          });
          try {
            await emitSyncCatchupNotification(tenantId, "service_titan", autoBackfillReason ?? "clamped", autoBackfillDays);
          } catch (notifyErr) {
            console.error(`[Sync] ServiceTitan tenant ${tenantId}: failed to emit catch-up notification`, notifyErr);
          }
        }
      } catch (dispatchErr) {
        console.error(
          `[Sync] ServiceTitan tenant ${tenantId}: failed to dispatch auto-backfill`,
          dispatchErr,
        );
      }
    }
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

  // Per-tenant advisory lock (0x47414453 = 'GADS') prevents the hourly
  // scheduled sync from racing with a manual Google Ads backfill on the
  // same campaign SELECT/INSERT path (which could otherwise create
  // duplicate campaigns under contention).
  const lockResult = await db.execute(sql`SELECT pg_try_advisory_lock(${0x47414453}, ${tenantId}) AS got`);
  const gotLock = (lockResult.rows[0] as { got: boolean } | undefined)?.got === true;
  if (!gotLock) {
    const errorMessage = "Another Google Ads sync is already running for this tenant";
    await completeSyncLog(syncLog.id, "error", 0, errorMessage);
    return { synced: 0, error: errorMessage };
  }

  // Task #567: nightly/hourly Google Ads sync uses a fixed 90-day rolling
  // window. A tenant paused for months silently loses any campaign-day rows
  // older than that window once the next run lands. Look at the last
  // *completed* sync log as the watermark; if the gap exceeds the rolling
  // window, stash an auto-backfill request and dispatch it from `finally`
  // (after we release the GADS lock — `backfillGoogleAdsCampaigns`
  // re-acquires the same lock).
  let autoBackfillDays: number | null = null;
  let autoBackfillReason: string | null = null;
  const GADS_ROLLING_WINDOW_DAYS = 90;
  const [lastGadsSync] = await db.select({ completedAt: integrationSyncLogsTable.completedAt })
    .from(integrationSyncLogsTable)
    .where(and(
      eq(integrationSyncLogsTable.tenantId, tenantId),
      eq(integrationSyncLogsTable.integration, "google_ads"),
      eq(integrationSyncLogsTable.syncType, "campaigns"),
      eq(integrationSyncLogsTable.status, "completed"),
    ))
    .orderBy(desc(integrationSyncLogsTable.completedAt))
    .limit(1);
  if (lastGadsSync?.completedAt) {
    const gapDays = Math.ceil((Date.now() - lastGadsSync.completedAt.getTime()) / 86400000);
    if (gapDays > GADS_ROLLING_WINDOW_DAYS) {
      const missedDays = Math.min(730, gapDays);
      if (missedDays > 30) {
        autoBackfillDays = missedDays;
        autoBackfillReason = `watermark ${gapDays}d stale > rolling window ${GADS_ROLLING_WINDOW_DAYS}d`;
      }
    }
  }

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
  } finally {
    try {
      await db.execute(sql`SELECT pg_advisory_unlock(${0x47414453}, ${tenantId})`);
    } catch (unlockErr) {
      console.error(`[Sync] Google Ads tenant ${tenantId}: failed to release advisory lock`, unlockErr);
    }

    // Task #567: dispatch the auto-backfill AFTER releasing the GADS lock,
    // since `backfillGoogleAdsCampaigns` re-acquires the same lock. De-dupe
    // against any in-flight `google_ads/backfill` row so a long-running
    // manual or prior auto-enqueued backfill isn't shadowed by a fresh
    // enqueue from a subsequent nightly tick. Fire-and-forget.
    if (autoBackfillDays !== null) {
      try {
        const [inFlight] = await db.select({ id: integrationSyncLogsTable.id })
          .from(integrationSyncLogsTable)
          .where(and(
            eq(integrationSyncLogsTable.tenantId, tenantId),
            eq(integrationSyncLogsTable.integration, "google_ads"),
            eq(integrationSyncLogsTable.syncType, "backfill"),
            eq(integrationSyncLogsTable.status, "running"),
          ))
          .limit(1);
        if (inFlight) {
          console.log(
            `[Sync] Google Ads tenant ${tenantId}: nightly clamped (${autoBackfillReason}); skipping auto-backfill — existing google_ads/backfill log ${inFlight.id} still running`,
          );
        } else {
          console.log(
            `[Sync] Google Ads tenant ${tenantId}: nightly clamped (${autoBackfillReason}); auto-enqueuing backfillGoogleAdsCampaigns(days=${autoBackfillDays}) linked to sync log ${syncLog.id}`,
          );
          void backfillGoogleAdsCampaigns(tenantId, autoBackfillDays).catch((err) => {
            console.error(
              `[Sync] Google Ads tenant ${tenantId}: auto-enqueued backfill failed`,
              err,
            );
          });
          try {
            await emitSyncCatchupNotification(tenantId, "google_ads", autoBackfillReason ?? "clamped", autoBackfillDays);
          } catch (notifyErr) {
            console.error(`[Sync] Google Ads tenant ${tenantId}: failed to emit catch-up notification`, notifyErr);
          }
        }
      } catch (dispatchErr) {
        console.error(
          `[Sync] Google Ads tenant ${tenantId}: failed to dispatch auto-backfill`,
          dispatchErr,
        );
      }
    }
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

  // Task #564: when the nightly window is clamped at META_MAX_CATCHUP_DAYS
  // (tenant's watermark is months stale), enqueue an async backfill to fill
  // the gap older than the cap. We compute the request size inside `try`
  // but actually fire it from `finally` (after `pg_advisory_unlock`), since
  // `backfillMetaCampaigns` re-acquires the same META lock.
  let autoBackfillDays: number | null = null;
  let autoBackfillReason: string | null = null;

  try {
    // ── Task #561: incremental nightly window with weekly full refresh ──
    // Meta's default attribution window settles within ~7 days. Re-pulling
    // the full 30 days every night was the single biggest driver of code-17
    // rate-limit failures for high-volume tenants (Advantage). Strategy:
    //   • Default to a rolling `META_ATTRIBUTION_REFRESH_DAYS` window
    //     (env-overridable, defaults to 7).
    //   • Once per week per tenant (deterministic via tenantId mod) fall
    //     back to the original `META_FULL_REFRESH_DAYS` window (default 30)
    //     so late attribution back-fills are still captured.
    //   • First-ever nightly run for a tenant (no `metaLastSyncedAt`) also
    //     uses the full window so we don't ship with a 7-day cold start.
    const attributionRefreshDays = Math.max(
      1, Number(process.env.META_ATTRIBUTION_REFRESH_DAYS || "7"),
    );
    const fullRefreshDays = Math.max(
      attributionRefreshDays, Number(process.env.META_FULL_REFRESH_DAYS || "30"),
    );
    // Hard cap on how far back nightly sync will ever reach in a single run,
    // even if the tenant's watermark is months stale. Older history is the
    // backfill route's job (`backfillMetaCampaigns`, which now uses Meta's
    // async report endpoint).
    const maxCatchupDays = Math.max(
      fullRefreshDays, Number(process.env.META_MAX_CATCHUP_DAYS || "90"),
    );
    const dayOfWeek = new Date().getUTCDay(); // 0..6
    const isWeeklyFullRefresh = ((tenantId + dayOfWeek) % 7) === 0;
    const isFirstRun = !tenant.metaLastSyncedAt;
    const useFullRefresh = isFirstRun || isWeeklyFullRefresh;
    const baseWindowDays = useFullRefresh ? fullRefreshDays : attributionRefreshDays;

    // Watermark catch-up: if the last successful sync is older than the
    // base window (e.g. tenant was paused for two weeks), widen `since` to
    // `metaLastSyncedAt - attributionRefreshDays` so we still pick up any
    // attribution back-fills inside the gap. Capped at `maxCatchupDays`.
    const nowMs = Date.now();
    const baseSinceMs = nowMs - baseWindowDays * 86400000;
    const watermarkMs = tenant.metaLastSyncedAt
      ? new Date(tenant.metaLastSyncedAt as Date).getTime() - attributionRefreshDays * 86400000
      : baseSinceMs;
    const capMs = nowMs - maxCatchupDays * 86400000;
    const sinceMs = Math.max(capMs, Math.min(baseSinceMs, watermarkMs));
    const isCatchup = sinceMs < baseSinceMs;
    const windowDays = Math.round((nowMs - sinceMs) / 86400000);

    // Task #564: clamp = nightly was about to widen further than the cap
    // (i.e. tenant's effective watermark is older than maxCatchupDays). The
    // missed range from `watermarkMs` back to today must be handled by the
    // backfill route, which uses Meta's async report endpoint and a
    // separate rate-limit budget. We stash `autoBackfillDays` here and
    // dispatch from `finally` after the advisory lock is released.
    if (tenant.metaLastSyncedAt && watermarkMs < capMs) {
      const missedDays = Math.min(1095, Math.ceil((nowMs - watermarkMs) / 86400000));
      if (missedDays > 30) {
        autoBackfillDays = missedDays;
        autoBackfillReason = `watermark ${Math.round((nowMs - new Date(tenant.metaLastSyncedAt as Date).getTime()) / 86400000)}d stale > cap ${maxCatchupDays}d`;
      }
    }

    const endDate = new Date(nowMs).toISOString().split("T")[0];
    const startDate = new Date(sinceMs).toISOString().split("T")[0];

    const svc = new MetaAPIService({
      accessToken: config.metaAccessToken,
      adAccountId,
      pixelId: config.metaPixelId,
    });

    const modeLabel = isFirstRun
      ? "full-refresh:first-run"
      : isCatchup
        ? `catchup:${useFullRefresh ? "full" : "incremental"}`
        : useFullRefresh
          ? "full-refresh:weekly"
          : "incremental";
    console.log(
      `[Sync] Meta tenant ${tenantId}: window=${startDate}→${endDate} (${windowDays}d, ${modeLabel})`,
    );

    // Use account currency if known (from meta_ad_accounts).
    let currency: string | undefined;
    try {
      const { metaAdAccountsTable } = await import("@workspace/db");
      const [acct] = await db.select().from(metaAdAccountsTable)
        .where(and(eq(metaAdAccountsTable.tenantId, tenantId), eq(metaAdAccountsTable.accountId, accountIdNoPrefix)))
        .limit(1);
      currency = acct?.currency;
    } catch (currencyErr) {
      console.warn(`[Sync] Meta tenant ${tenantId}: could not read account currency, falling back to null`, currencyErr);
    }

    // Fetch ad-set + ad metadata so we can persist names/statuses/budgets.
    // `fetchAds()` no longer expands `creative{…}` — the idempotent
    // `backfillMetaAdCreatives` job handles thumbnail/title/body. This drops
    // one expansion per ad per night off the rate-limit budget (Task #561).
    const [adSets, ads, insights] = await Promise.all([
      svc.fetchAdSets(),
      svc.fetchAds(/* includeCreative */ false),
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
        creativeThumbnailUrl: a.creative?.thumbnail_url ?? null,
        creativeTitle: a.creative?.title ?? null,
        creativeBody: a.creative?.body ?? null,
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
              creativeThumbnailUrl: sql`excluded.creative_thumbnail_url`,
              creativeTitle: sql`excluded.creative_title`,
              creativeBody: sql`excluded.creative_body`,
              updatedAt: sql`now()`,
            },
          });
      }
    }

    const { perAdSynced, campaignDayCount } = await upsertMetaInsightRows(
      tenantId, accountIdNoPrefix, currency, insights,
    );

    await db.update(tenantsTable)
      .set({ metaLastSyncedAt: new Date(), metaNeedsReconnect: false, metaReconnectReason: null, updatedAt: new Date() })
      .where(eq(tenantsTable.id, tenantId));

    await completeSyncLog(syncLog.id, "completed", perAdSynced);
    console.log(
      `[Sync] Meta tenant ${tenantId}: ${perAdSynced} ad-day rows, ${campaignDayCount} campaign-day rollups, ${svc.requestCount} Graph requests (window=${startDate}→${endDate}, ${useFullRefresh ? "full" : "incremental"})`,
    );
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
    try {
      await db.execute(sql`SELECT pg_advisory_unlock(${0x4d455441}, ${tenantId})`);
    } catch (unlockErr) {
      console.error(`[Sync] Meta tenant ${tenantId}: failed to release advisory lock`, unlockErr);
    }

    // Task #564: dispatch the auto-backfill AFTER releasing the META lock,
    // since `backfillMetaCampaigns` re-acquires the same lock. De-dupe
    // against any in-flight `meta/backfill` row so a slow async report
    // already mid-run isn't shadowed by a fresh enqueue from a subsequent
    // nightly tick. Fire-and-forget: nightly returns immediately, the
    // async report continues in the background.
    if (autoBackfillDays !== null) {
      try {
        const [inFlight] = await db.select({ id: integrationSyncLogsTable.id })
          .from(integrationSyncLogsTable)
          .where(and(
            eq(integrationSyncLogsTable.tenantId, tenantId),
            eq(integrationSyncLogsTable.integration, "meta"),
            eq(integrationSyncLogsTable.syncType, "backfill"),
            eq(integrationSyncLogsTable.status, "running"),
          ))
          .limit(1);
        if (inFlight) {
          console.log(
            `[Sync] Meta tenant ${tenantId}: nightly clamped (${autoBackfillReason}); skipping auto-backfill — existing meta/backfill log ${inFlight.id} still running`,
          );
        } else {
          console.log(
            `[Sync] Meta tenant ${tenantId}: nightly clamped (${autoBackfillReason}); auto-enqueuing backfillMetaCampaigns(days=${autoBackfillDays}) linked to sync log ${syncLog.id}`,
          );
          void backfillMetaCampaigns(tenantId, autoBackfillDays, { triggeredBySyncLogId: syncLog.id }).catch((err) => {
            console.error(
              `[Sync] Meta tenant ${tenantId}: auto-enqueued backfill failed`,
              err,
            );
          });
          try {
            await emitSyncCatchupNotification(tenantId, "meta", autoBackfillReason ?? "clamped", autoBackfillDays);
          } catch (notifyErr) {
            console.error(`[Sync] Meta tenant ${tenantId}: failed to emit catch-up notification`, notifyErr);
          }
        }
      } catch (dispatchErr) {
        console.error(
          `[Sync] Meta tenant ${tenantId}: failed to dispatch auto-backfill`,
          dispatchErr,
        );
      }
    }
  }
}

/**
 * One-shot backfill that fills in `creative_thumbnail_url`/`creative_title`/`creative_body`
 * on `meta_ads` rows for a tenant whose ads were synced before those columns were captured.
 *
 * Safe to re-run: only targets rows that still have a `creative_id` but no `creative_thumbnail_url`.
 * Calls Meta `/<creative_id>?fields=thumbnail_url,title,body` once per unique creative id
 * (multiple ads can share a creative) and sleeps `delayMs` between calls to stay under the
 * tenant's per-app rate limit. Token-expiry flips the same `metaNeedsReconnect` flag the
 * regular sync does. Honors the same `META` advisory lock so it can't race a live sync.
 */
export async function backfillMetaAdCreatives(
  tenantId: number,
  options: { delayMs?: number; maxCreatives?: number } = {},
): Promise<{ scanned: number; fetched: number; updated: number; skipped: number; errors: number; error?: string }> {
  const delayMs = Math.max(0, options.delayMs ?? 250);
  const maxCreatives = options.maxCreatives && options.maxCreatives > 0 ? options.maxCreatives : Infinity;

  const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId));
  if (!tenant) return { scanned: 0, fetched: 0, updated: 0, skipped: 0, errors: 0, error: "Tenant not found" };

  if (tenant.metaNeedsReconnect) {
    return {
      scanned: 0, fetched: 0, updated: 0, skipped: 0, errors: 0,
      error: `Meta needs reconnect: ${tenant.metaReconnectReason || "access token expired"}`,
    };
  }

  const config = getTenantConfig(tenant);
  if (!config?.metaAccessToken) {
    return { scanned: 0, fetched: 0, updated: 0, skipped: 0, errors: 0, error: "Meta not configured (missing access token)" };
  }

  const lockResult = await db.execute(sql`SELECT pg_try_advisory_lock(${0x4d455441}, ${tenantId}) AS got`);
  const gotLock = (lockResult.rows[0] as { got: boolean } | undefined)?.got === true;
  if (!gotLock) {
    return { scanned: 0, fetched: 0, updated: 0, skipped: 0, errors: 0, error: "Another Meta sync is already running for this tenant" };
  }

  const syncLog = await logSync(tenantId, "meta", "creative_backfill", new Date());
  let fetched = 0;
  let updated = 0;
  let errors = 0;

  try {
    // Find ads missing creative metadata. A row is "missing" only when ALL three
    // creative_* columns are null — that way a previous backfill that filled in
    // title/body but couldn't get a thumbnail (some Meta creatives just don't
    // expose one) won't keep re-triggering API calls forever.
    // One row per ad but we'll dedupe by creative id.
    const adsMissing = await db.select({
      externalId: metaAdsTable.externalId,
      creativeId: metaAdsTable.creativeId,
    }).from(metaAdsTable).where(and(
      eq(metaAdsTable.tenantId, tenantId),
      isNotNull(metaAdsTable.creativeId),
      isNull(metaAdsTable.creativeThumbnailUrl),
      isNull(metaAdsTable.creativeTitle),
      isNull(metaAdsTable.creativeBody),
    ));

    const scanned = adsMissing.length;
    if (scanned === 0) {
      await completeSyncLog(syncLog.id, "completed", 0);
      return { scanned: 0, fetched: 0, updated: 0, skipped: 0, errors: 0 };
    }

    // Group ad ids by creative id so we only fetch each creative once.
    const adsByCreative = new Map<string, string[]>();
    for (const row of adsMissing) {
      if (!row.creativeId) continue;
      const list = adsByCreative.get(row.creativeId) ?? [];
      list.push(row.externalId);
      adsByCreative.set(row.creativeId, list);
    }

    const svc = new MetaAPIService({ accessToken: config.metaAccessToken, adAccountId: config.metaAdAccountId || "" });

    let processed = 0;
    for (const [creativeId, adExternalIds] of adsByCreative) {
      if (processed >= maxCreatives) break;
      processed++;

      try {
        const creative = await svc.fetchAdCreative(creativeId);
        fetched++;

        // Skip update if Meta returned nothing useful (avoid clobbering with all nulls
        // and re-triggering the backfill on every run).
        if (!creative.thumbnail_url && !creative.title && !creative.body) {
          continue;
        }

        const result = await db.update(metaAdsTable)
          .set({
            creativeThumbnailUrl: creative.thumbnail_url ?? null,
            creativeTitle: creative.title ?? null,
            creativeBody: creative.body ?? null,
            updatedAt: new Date(),
          })
          .where(and(
            eq(metaAdsTable.tenantId, tenantId),
            eq(metaAdsTable.creativeId, creativeId),
            isNull(metaAdsTable.creativeThumbnailUrl),
          ));
        const rowCount = (result as unknown as { rowCount?: number }).rowCount ?? adExternalIds.length;
        updated += rowCount;
      } catch (err) {
        errors++;
        if (err instanceof MetaTokenInvalidError) {
          const message = err.message;
          await db.update(tenantsTable)
            .set({ metaNeedsReconnect: true, metaReconnectReason: message, updatedAt: new Date() })
            .where(eq(tenantsTable.id, tenantId));
          await completeSyncLog(syncLog.id, "error", updated, message);
          console.error(`[Backfill] Meta tenant ${tenantId} token expired during creative backfill — flagged for reconnect`);
          return { scanned, fetched, updated, skipped: scanned - updated - errors, errors, error: message };
        }
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[Backfill] Meta tenant ${tenantId} creative ${creativeId} fetch failed: ${msg}`);
      }

      if (delayMs > 0 && processed < adsByCreative.size && processed < maxCreatives) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    const skipped = scanned - updated - errors;
    await completeSyncLog(syncLog.id, errors > 0 && updated === 0 ? "error" : "completed", updated);
    console.log(
      `[Backfill] Meta tenant ${tenantId}: scanned=${scanned} creatives=${adsByCreative.size} fetched=${fetched} updated=${updated} errors=${errors}`,
    );
    return { scanned, fetched, updated, skipped: Math.max(0, skipped), errors };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await completeSyncLog(syncLog.id, "error", updated, message);
    console.error(`[Backfill] Meta tenant ${tenantId} creative backfill failed:`, message);
    return { scanned: 0, fetched, updated, skipped: 0, errors: errors + 1, error: message };
  } finally {
    try {
      await db.execute(sql`SELECT pg_advisory_unlock(${0x4d455441}, ${tenantId})`);
    } catch (unlockErr) {
      console.error(`[Backfill] Meta tenant ${tenantId}: failed to release advisory lock`, unlockErr);
    }
  }
}

interface MetaInsightLikeRow {
  ad_id?: string;
  adset_id?: string;
  campaign_id: string;
  campaign_name?: string;
  date_start: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  actions?: MetaAction[];
}

/**
 * Bucket per-ad insights into per-ad-day rows + per-campaign-day rollups, then
 * upsert both into `meta_ad_daily_stats` and `campaign_daily_stats` using the
 * same ON CONFLICT batched path as the nightly sync. Shared by the nightly
 * 30-day sync (`syncMetaCampaigns`) and the historical backfill
 * (`backfillMetaCampaigns`).
 *
 * Both callers MUST hold the per-tenant Meta advisory lock before calling
 * this — concurrent writers would race on the unique-index upserts.
 */
async function upsertMetaInsightRows(
  tenantId: number,
  accountIdNoPrefix: string,
  currency: string | undefined,
  insights: MetaInsightLikeRow[],
): Promise<{ perAdSynced: number; campaignDayCount: number }> {
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
    // Task #561: dropped video_play_actions / video_pNN_watched_actions —
    // nothing in the codebase ever read them, and pulling them inflated
    // Meta's per-user rate-limit scoring. If video metrics come back,
    // gate them behind a per-tenant feature flag.
    const actionsPayload: Record<string, MetaAction[]> = { actions };

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
      actionsJson: actionsPayload,
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

  return { perAdSynced: adDailyRows.length, campaignDayCount: campaignBuckets.size };
}

/**
 * One-shot historical backfill of Meta per-ad insights for the trailing
 * `days` window (default 365, capped at 1095 ≈ 3 years to stay inside Meta's
 * insights retention). Iterates the range in 30-day chunks so each Graph API
 * call stays well under per-request row limits, and reuses the same
 * ON CONFLICT upsert path as the nightly sync via `upsertMetaInsightRows`.
 *
 * Honors the same per-tenant advisory lock as `syncMetaCampaigns` so the
 * nightly scheduler can never race against an in-flight backfill.
 *
 * Surfaces progress in `integration_sync_logs` with sync_type=`backfill`:
 *   - `recordsProcessed` counts ad-day rows written so far
 *   - `errorMessage` carries a human-readable progress string
 *     (e.g. "chunk 3/12: 2024-09-01 → 2024-09-30") while running and
 *     is cleared to NULL on completion.
 */
export async function backfillMetaCampaigns(
  tenantId: number,
  days: number,
  options?: { triggeredBySyncLogId?: number | null },
): Promise<{ synced: number; chunks: number; error?: string }> {
  const triggeredBySyncLogId = options?.triggeredBySyncLogId ?? null;
  const requestedDays = Number.isFinite(days) ? Math.floor(days) : 0;
  if (requestedDays <= 30) {
    return { synced: 0, chunks: 0, error: "days must be > 30 (use the nightly sync for the rolling 30-day window)" };
  }
  const totalDays = Math.min(requestedDays, 1095);

  const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId));
  if (!tenant) return { synced: 0, chunks: 0, error: "Tenant not found" };

  if (tenant.metaNeedsReconnect) {
    const errorMessage = `Meta needs reconnect: ${tenant.metaReconnectReason || "access token expired"}`;
    const skippedLog = await logSync(tenantId, "meta", "backfill", new Date(), { triggeredBySyncLogId });
    await completeSyncLog(skippedLog.id, "error", 0, errorMessage);
    return { synced: 0, chunks: 0, error: errorMessage };
  }

  const config = getTenantConfig(tenant);
  if (!config?.metaAccessToken || !config?.metaAdAccountId) {
    const missing = [
      !config?.metaAccessToken && "Access Token (run Meta OAuth)",
      !config?.metaAdAccountId && "Ad Account selection",
    ].filter(Boolean).join(", ");
    const errorMessage = `Meta not configured (missing: ${missing})`;
    const missingLog = await logSync(tenantId, "meta", "backfill", new Date(), { triggeredBySyncLogId });
    await completeSyncLog(missingLog.id, "error", 0, errorMessage);
    return { synced: 0, chunks: 0, error: errorMessage };
  }

  const syncLog = await logSync(tenantId, "meta", "backfill", new Date(), { triggeredBySyncLogId });
  const adAccountId = config.metaAdAccountId.startsWith("act_") ? config.metaAdAccountId : `act_${config.metaAdAccountId}`;
  const accountIdNoPrefix = adAccountId.replace(/^act_/, "");

  const lockResult = await db.execute(sql`SELECT pg_try_advisory_lock(${0x4d455441}, ${tenantId}) AS got`);
  const gotLock = (lockResult.rows[0] as { got: boolean } | undefined)?.got === true;
  if (!gotLock) {
    const errorMessage = "Another Meta sync is already running for this tenant";
    await completeSyncLog(syncLog.id, "error", 0, errorMessage);
    return { synced: 0, chunks: 0, error: errorMessage };
  }

  try {
    const svc = new MetaAPIService({
      accessToken: config.metaAccessToken,
      adAccountId,
      pixelId: config.metaPixelId,
    });

    let currency: string | undefined;
    try {
      const { metaAdAccountsTable } = await import("@workspace/db");
      const [acct] = await db.select().from(metaAdAccountsTable)
        .where(and(eq(metaAdAccountsTable.tenantId, tenantId), eq(metaAdAccountsTable.accountId, accountIdNoPrefix)))
        .limit(1);
      currency = acct?.currency;
    } catch (currencyErr) {
      console.warn(`[Backfill] Meta tenant ${tenantId}: could not read account currency`, currencyErr);
    }

    // Iterate from oldest → newest in 30-day chunks. Going forward in time
    // means each upsert overwrites with progressively more-recent attribution
    // back-fills from Meta, matching the nightly sync's "last write wins"
    // semantics on (tenant, ad, date).
    const CHUNK_DAYS = 30;
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const oldest = new Date(today.getTime() - totalDays * 86400000);

    const chunks: Array<{ since: string; until: string }> = [];
    for (let cursor = new Date(oldest); cursor < today; cursor = new Date(cursor.getTime() + CHUNK_DAYS * 86400000)) {
      const since = cursor.toISOString().split("T")[0];
      const untilDate = new Date(Math.min(cursor.getTime() + (CHUNK_DAYS - 1) * 86400000, today.getTime() - 86400000));
      const until = untilDate.toISOString().split("T")[0];
      chunks.push({ since, until });
    }

    let totalSynced = 0;
    try {
      for (let i = 0; i < chunks.length; i++) {
        const { since, until } = chunks[i];
        await updateSyncLogChunkProgress(
          syncLog.id,
          totalSynced,
          i + 1,
          chunks.length,
          since,
          until,
        );
        // Task #561: route historical chunks through Meta's async report
        // endpoint. Async reports are tracked against a separate per-app
        // budget from synchronous `/insights` calls, so heavy multi-month
        // backfills no longer starve the nightly sync's per-user quota.
        // `MetaTokenInvalidError` still bubbles through unchanged so the
        // reconnect-flag logic from Task #556 keeps working.
        const insights = await svc.fetchAdDailyInsightsAsync(since, until);
        const { perAdSynced } = await upsertMetaInsightRows(tenantId, accountIdNoPrefix, currency, insights);
        totalSynced += perAdSynced;
        console.log(`[Backfill] Meta tenant ${tenantId} chunk ${i + 1}/${chunks.length} ${since}→${until}: ${perAdSynced} ad-day rows (async, ${svc.requestCount} requests so far)`);
      }
    } catch (innerErr) {
      // Re-throw so the outer catch handles error-state, but stash partial
      // progress on the log first so operators don't lose visibility into
      // how far the backfill got before failing.
      const innerMessage = innerErr instanceof Error ? innerErr.message : String(innerErr);
      try { await updateSyncLogPartialFailure(syncLog.id, totalSynced, innerMessage); } catch {}
      throw innerErr;
    }

    await completeSyncLog(syncLog.id, "completed", totalSynced);
    console.log(`[Backfill] Meta tenant ${tenantId}: backfilled ${totalSynced} ad-day rows across ${chunks.length} chunks (${totalDays} days, ${svc.requestCount} Graph requests)`);
    return { synced: totalSynced, chunks: chunks.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof MetaTokenInvalidError) {
      await db.update(tenantsTable)
        .set({ metaNeedsReconnect: true, metaReconnectReason: message, updatedAt: new Date() })
        .where(eq(tenantsTable.id, tenantId));
      console.error(`[Backfill] Meta tenant ${tenantId} token expired — flagged for reconnect`);
    }
    await completeSyncLog(syncLog.id, "error", 0, message);
    console.error(`[Backfill] Meta error for tenant ${tenantId}:`, message);
    try { await emitSyncFailureNotification(tenantId, "meta", message); } catch {}
    return { synced: 0, chunks: 0, error: message };
  } finally {
    try {
      await db.execute(sql`SELECT pg_advisory_unlock(${0x4d455441}, ${tenantId})`);
    } catch (unlockErr) {
      console.error(`[Backfill] Meta tenant ${tenantId}: failed to release advisory lock`, unlockErr);
    }
  }
}

/**
 * One-shot historical Google Ads backfill. Pulls per-campaign daily metrics
 * for the trailing `days` window (default 365, capped at 730 ≈ 2 years to
 * stay inside Google Ads' standard reporting retention) in 30-day chunks
 * iterating oldest → newest. Mirrors `syncGoogleAdsCampaigns`'s SELECT/INSERT
 * upsert path so a manual backfill can't double-create campaigns or stat
 * rows. Progress + completion land in `integration_sync_logs` with
 * sync_type=`backfill` (recordsProcessed = stat rows written).
 */
export async function backfillGoogleAdsCampaigns(
  tenantId: number,
  days: number,
): Promise<{ synced: number; chunks: number; error?: string }> {
  const requestedDays = Number.isFinite(days) ? Math.floor(days) : 0;
  if (requestedDays <= 30) {
    return { synced: 0, chunks: 0, error: "days must be > 30 (use the hourly sync for the rolling 90-day window)" };
  }
  const totalDays = Math.min(requestedDays, 730);

  const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId));
  if (!tenant) return { synced: 0, chunks: 0, error: "Tenant not found" };

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
    const missingLog = await logSync(tenantId, "google_ads", "backfill", new Date());
    await completeSyncLog(missingLog.id, "error", 0, missingMessage);
    return { synced: 0, chunks: 0, error: missingMessage };
  }

  const syncLog = await logSync(tenantId, "google_ads", "backfill", new Date());

  // Share the per-tenant lock with `syncGoogleAdsCampaigns` so a manual
  // backfill and the hourly scheduled sync can never overlap.
  const lockResult = await db.execute(sql`SELECT pg_try_advisory_lock(${0x47414453}, ${tenantId}) AS got`);
  const gotLock = (lockResult.rows[0] as { got: boolean } | undefined)?.got === true;
  if (!gotLock) {
    const errorMessage = "Another Google Ads sync is already running for this tenant";
    await completeSyncLog(syncLog.id, "error", 0, errorMessage);
    return { synced: 0, chunks: 0, error: errorMessage };
  }

  try {
    const gaConfig = {
      developerToken: config!.googleAdsDeveloperToken!,
      accessToken: config!.googleAdsApiKey || "",
      refreshToken: config!.googleAdsRefreshToken,
      clientId: config!.googleAdsClientId,
      clientSecret: config!.googleAdsClientSecret,
      customerId: config!.googleAdsCustomerId!,
      loginCustomerId: config!.googleAdsLoginCustomerId,
    };

    const CHUNK_DAYS = 30;
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const oldest = new Date(today.getTime() - totalDays * 86400000);

    const chunks: Array<{ since: string; until: string }> = [];
    for (let cursor = new Date(oldest); cursor < today; cursor = new Date(cursor.getTime() + CHUNK_DAYS * 86400000)) {
      const since = cursor.toISOString().split("T")[0];
      const untilDate = new Date(Math.min(cursor.getTime() + (CHUNK_DAYS - 1) * 86400000, today.getTime() - 86400000));
      const until = untilDate.toISOString().split("T")[0];
      chunks.push({ since, until });
    }

    let totalSynced = 0;
    try {
      for (let i = 0; i < chunks.length; i++) {
        const { since, until } = chunks[i];
        await updateSyncLogChunkProgress(
          syncLog.id,
          totalSynced,
          i + 1,
          chunks.length,
          since,
          until,
        );

        const rows = await fetchCampaignPerformance(gaConfig, since, until);
        for (const row of rows) {
          const formatted = formatCampaignRow(row);

          let [campaign] = await db.select().from(campaignsTable)
            .where(and(
              eq(campaignsTable.tenantId, tenantId),
              eq(campaignsTable.platform, "google_ads"),
              eq(campaignsTable.externalId, formatted.externalId),
            ))
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
          totalSynced++;
        }
        console.log(`[Backfill] Google Ads tenant ${tenantId} chunk ${i + 1}/${chunks.length} ${since}→${until}: ${rows.length} campaign-day rows`);
      }
    } catch (innerErr) {
      const innerMessage = innerErr instanceof Error ? innerErr.message : String(innerErr);
      try { await updateSyncLogPartialFailure(syncLog.id, totalSynced, innerMessage); } catch {}
      throw innerErr;
    }

    await completeSyncLog(syncLog.id, "completed", totalSynced);
    console.log(`[Backfill] Google Ads tenant ${tenantId}: backfilled ${totalSynced} campaign-day rows across ${chunks.length} chunks (${totalDays} days)`);
    return { synced: totalSynced, chunks: chunks.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await completeSyncLog(syncLog.id, "error", 0, message);
    console.error(`[Backfill] Google Ads error for tenant ${tenantId}:`, message);
    try { await emitSyncFailureNotification(tenantId, "google_ads", message); } catch {}
    return { synced: 0, chunks: 0, error: message };
  } finally {
    try {
      await db.execute(sql`SELECT pg_advisory_unlock(${0x47414453}, ${tenantId})`);
    } catch (unlockErr) {
      console.error(`[Backfill] Google Ads tenant ${tenantId}: failed to release advisory lock`, unlockErr);
    }
  }
}

/**
 * One-shot historical ServiceTitan jobs backfill. Walks the trailing `days`
 * window (default 365, capped at 1095 ≈ 3 years) in 90-day chunks using the
 * `modifiedOnOrAfter` + `modifiedBefore` ServiceTitan filters so each chunk
 * stays well under the 50-page (5000 job) hard cap inside `fetchCompletedJobs`.
 * Reuses the same upsert + enrichment pipeline as the scheduled jobs sync.
 * Progress + completion land in `integration_sync_logs` with
 * sync_type=`backfill`.
 */
export async function backfillServiceTitanJobs(
  tenantId: number,
  days: number,
): Promise<{ synced: number; chunks: number; error?: string }> {
  const requestedDays = Number.isFinite(days) ? Math.floor(days) : 0;
  if (requestedDays <= 30) {
    return { synced: 0, chunks: 0, error: "days must be > 30 (the 15-min scheduler already covers recent jobs)" };
  }
  const totalDays = Math.min(requestedDays, 1095);

  const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId));
  if (!tenant) return { synced: 0, chunks: 0, error: "Tenant not found" };

  if (tenant.stSyncPaused) {
    const errorMessage = "ServiceTitan sync is paused for this tenant";
    const skippedLog = await logSync(tenantId, "service_titan", "backfill", new Date());
    await completeSyncLog(skippedLog.id, "error", 0, errorMessage);
    return { synced: 0, chunks: 0, error: errorMessage };
  }

  const config = getTenantConfig(tenant);
  if (!config?.serviceTitanClientId || !config?.serviceTitanClientSecret || !config?.serviceTitanAppKey) {
    const missing = [
      !config?.serviceTitanClientId && "Client ID",
      !config?.serviceTitanClientSecret && "Client Secret",
      !config?.serviceTitanAppKey && "App Key",
    ].filter(Boolean).join(", ");
    const errorMessage = `ServiceTitan not configured (missing: ${missing})`;
    const missingLog = await logSync(tenantId, "service_titan", "backfill", new Date());
    await completeSyncLog(missingLog.id, "error", 0, errorMessage);
    return { synced: 0, chunks: 0, error: errorMessage };
  }

  const syncLog = await logSync(tenantId, "service_titan", "backfill", new Date());

  // Share the per-tenant lock with `syncServiceTitanJobs` so a manual
  // backfill and the 15-min scheduled sync can never overlap on the same
  // job upserts.
  const lockResult = await db.execute(sql`SELECT pg_try_advisory_lock(${0x5354414e}, ${tenantId}) AS got`);
  const gotLock = (lockResult.rows[0] as { got: boolean } | undefined)?.got === true;
  if (!gotLock) {
    const errorMessage = "Another ServiceTitan sync is already running for this tenant";
    await completeSyncLog(syncLog.id, "error", 0, errorMessage);
    return { synced: 0, chunks: 0, error: errorMessage };
  }

  try {
    const stConfig = {
      clientId: config.serviceTitanClientId,
      clientSecret: config.serviceTitanClientSecret,
      tenantId: config.serviceTitanTenantId || tenant.serviceTitanId || "",
      appKey: config.serviceTitanAppKey,
    };

    const CHUNK_DAYS = 90;
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const oldest = new Date(today.getTime() - totalDays * 86400000);

    const chunks: Array<{ since: string; before: string }> = [];
    for (let cursor = new Date(oldest); cursor < today; cursor = new Date(cursor.getTime() + CHUNK_DAYS * 86400000)) {
      const since = cursor.toISOString();
      const beforeMs = Math.min(cursor.getTime() + CHUNK_DAYS * 86400000, today.getTime());
      const before = new Date(beforeMs).toISOString();
      chunks.push({ since, before });
    }

    let totalSynced = 0;
    let currentChunkIdx = 0;
    let cancelledAt: { chunkIdx: number; rows: number } | null = null;

    // Throw-to-unwind sentinel: the only way to stop `fetchCompletedJobs`
    // mid-page-walk is to make `processJobBatch` throw. The outer try/catch
    // distinguishes this from a real upstream error by checking
    // `cancelledAt`.
    class BackfillCancelled extends Error {
      constructor() { super("backfill cancelled"); this.name = "BackfillCancelled"; }
    }

    async function checkCancel(): Promise<boolean> {
      try {
        const [row] = await db.select({ cancel: integrationSyncLogsTable.cancelRequested })
          .from(integrationSyncLogsTable)
          .where(eq(integrationSyncLogsTable.id, syncLog.id))
          .limit(1);
        return row?.cancel === true;
      } catch {
        return false;
      }
    }

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
        totalSynced++;
      }

      // Flush in-flight progress so the Internal-page progress card ticks up
      // as each ~500-job batch lands instead of staying at the chunk-start
      // snapshot for 5-10 minutes per chunk. Best-effort: never let a sync
      // log write failure abort the batch loop.
      if (chunks.length > 0 && currentChunkIdx < chunks.length) {
        const { since, before } = chunks[currentChunkIdx];
        try {
          await updateSyncLogChunkProgress(
            syncLog.id,
            totalSynced,
            currentChunkIdx + 1,
            chunks.length,
            since.slice(0, 10),
            before.slice(0, 10),
          );
        } catch (progressErr) {
          console.warn(`[Backfill] ServiceTitan tenant ${tenantId}: in-flight progress write failed`, (progressErr as Error).message);
        }
      }

      // Cooperative cancel check: poll the sync log row after each batch. If
      // the cancel route flipped the flag, throw to unwind out of
      // `fetchCompletedJobs`. The outer chunk loop catches this and marks
      // the run as cancelled instead of errored.
      if (await checkCancel()) {
        cancelledAt = { chunkIdx: currentChunkIdx, rows: totalSynced };
        throw new BackfillCancelled();
      }
    }

    try {
      for (let i = 0; i < chunks.length; i++) {
        // Cancel check at chunk boundary — cheap and frequent enough that a
        // user clicking Cancel sees a response within seconds, not minutes.
        if (await checkCancel()) {
          cancelledAt = { chunkIdx: i, rows: totalSynced };
          break;
        }
        currentChunkIdx = i;
        const { since, before } = chunks[i];
        await updateSyncLogChunkProgress(
          syncLog.id,
          totalSynced,
          i + 1,
          chunks.length,
          since.slice(0, 10),
          before.slice(0, 10),
        );
        await fetchCompletedJobs(stConfig, since, processJobBatch, before);
      }
    } catch (innerErr) {
      // BackfillCancelled is an expected unwind path, not a partial failure.
      if (innerErr instanceof BackfillCancelled) {
        // fall through to the cancelled-completion path below
      } else {
        const innerMessage = innerErr instanceof Error ? innerErr.message : String(innerErr);
        try { await updateSyncLogPartialFailure(syncLog.id, totalSynced, innerMessage); } catch {}
        throw innerErr;
      }
    }

    if (cancelledAt) {
      await completeSyncLog(syncLog.id, "cancelled", totalSynced, `Cancelled by operator after chunk ${cancelledAt.chunkIdx + 1}/${chunks.length} (${totalSynced} rows synced)`);
      console.log(`[Backfill] ServiceTitan tenant ${tenantId}: cancelled after ${totalSynced} jobs (chunk ${cancelledAt.chunkIdx + 1}/${chunks.length})`);
      if (totalSynced > 0) {
        try { await matchJobsToLeads(tenantId); } catch (err) {
          console.error(`[Backfill] ServiceTitan post-cancel lead match failed for tenant ${tenantId}:`, (err as Error).message);
        }
      }
      return { synced: totalSynced, chunks: cancelledAt.chunkIdx, error: "cancelled" };
    }

    await completeSyncLog(syncLog.id, "completed", totalSynced);
    console.log(`[Backfill] ServiceTitan tenant ${tenantId}: backfilled ${totalSynced} jobs across ${chunks.length} chunks (${totalDays} days)`);

    if (totalSynced > 0) {
      try { await matchJobsToLeads(tenantId); } catch (err) {
        console.error(`[Backfill] ServiceTitan post-sync lead match failed for tenant ${tenantId}:`, (err as Error).message);
      }
    }

    return { synced: totalSynced, chunks: chunks.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await completeSyncLog(syncLog.id, "error", 0, message);
    console.error(`[Backfill] ServiceTitan error for tenant ${tenantId}:`, message);
    try { await emitSyncFailureNotification(tenantId, "service_titan", message); } catch {}
    return { synced: 0, chunks: 0, error: message };
  } finally {
    try {
      await db.execute(sql`SELECT pg_advisory_unlock(${0x5354414e}, ${tenantId})`);
    } catch (unlockErr) {
      console.error(`[Backfill] ServiceTitan tenant ${tenantId}: failed to release advisory lock`, unlockErr);
    }
  }
}

export async function syncServiceTitanInvoices(tenantId: number, options?: { fullResync?: boolean }): Promise<{ synced: number; error?: string }> {
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

  const modifiedOnOrAfter = options?.fullResync ? undefined : (lastSuccessfulSync?.completedAt?.toISOString() ?? undefined);

  const syncLog = await logSync(tenantId, "service_titan", "invoices", new Date());

  try {
    const stConfig = {
      clientId: config.serviceTitanClientId,
      clientSecret: config.serviceTitanClientSecret,
      tenantId: config.serviceTitanTenantId || tenant.serviceTitanId || "",
      appKey: config.serviceTitanAppKey,
    };

    let synced = 0;
    let cancelled = false;

    // Cooperative cancel for the revenue-recompute full re-sync: mirrors the
    // backfill pattern. The cancel route flips `cancelRequested` on this
    // sync log; we poll it at batch boundaries and throw a sentinel to
    // unwind out of `fetchInvoices`, then complete the row as `cancelled`
    // keeping rows already processed (no rollback). Only armed for full
    // re-syncs — the 15-min incremental sync is too short to bother.
    class ResyncCancelled extends Error {
      constructor() { super("recompute cancelled"); this.name = "ResyncCancelled"; }
    }
    async function checkCancel(): Promise<boolean> {
      try {
        const [row] = await db.select({ cancel: integrationSyncLogsTable.cancelRequested })
          .from(integrationSyncLogsTable)
          .where(eq(integrationSyncLogsTable.id, syncLog.id))
          .limit(1);
        return row?.cancel === true;
      } catch {
        return false;
      }
    }

    const rebatePatterns = getTenantRebatePatterns(tenant);

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
          const parsed = parseInvoiceData(inv, rebatePatterns);
          totalInvoiceAmount += parsed.invoiceTotal;
          totalRebate += parsed.invoiceRebateAmount;
          totalPaid += parsed.invoicePaidAmount;
          totalBalance += parsed.invoiceBalance;
          if (parsed.invoicePaidOn && (!latestPaidOn || parsed.invoicePaidOn > latestPaidOn)) {
            latestPaidOn = parsed.invoicePaidOn;
          }
        }

        const latestInvoice = parseInvoiceData(sorted[0], rebatePatterns);

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

      // During a full re-sync (revenue recompute) publish the running tally
      // to the sync log after each batch so the Settings panel can poll and
      // show live progress. Skipped on incremental syncs to avoid an extra
      // write on every 15-min poll where the count barely moves.
      if (options?.fullResync) {
        await updateSyncLogRecords(syncLog.id, synced);

        // Cooperative cancel check at the batch boundary — frequent enough
        // that an operator clicking Cancel sees the run stop within seconds.
        if (await checkCancel()) {
          cancelled = true;
          throw new ResyncCancelled();
        }
      }
    }

    // On a full re-sync, capture the upstream total-count once so the
    // recompute card can show a percent-complete bar. Skipped on incremental
    // syncs — those report a running tally only.
    const onInvoiceTotal = options?.fullResync
      ? (total: number) => { void updateSyncLogTotalRecords(syncLog.id, total); }
      : undefined;
    try {
      await fetchInvoices(stConfig, modifiedOnOrAfter, processInvoiceBatch, onInvoiceTotal);
    } catch (innerErr) {
      // ResyncCancelled is the expected unwind path, not a real failure.
      if (!(innerErr instanceof ResyncCancelled)) throw innerErr;
    }

    if (cancelled) {
      await completeSyncLog(syncLog.id, "cancelled", synced, `Cancelled by operator (${synced} invoices processed)`);
      console.log(`[Sync] ServiceTitan invoices: cancelled after ${synced} invoices for tenant ${tenantId}`);
      return { synced, error: "cancelled" };
    }

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

export async function syncServiceTitanEstimates(tenantId: number, options?: { fullResync?: boolean }): Promise<{ synced: number; error?: string }> {
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

  const modifiedOnOrAfter = options?.fullResync ? undefined : (lastSuccessfulSync?.completedAt?.toISOString() ?? undefined);

  const syncLog = await logSync(tenantId, "service_titan", "estimates", new Date());

  try {
    const stConfig = {
      clientId: config.serviceTitanClientId,
      clientSecret: config.serviceTitanClientSecret,
      tenantId: config.serviceTitanTenantId || tenant.serviceTitanId || "",
      appKey: config.serviceTitanAppKey,
    };

    let synced = 0;
    let cancelled = false;
    clearEmployeeCache();
    const rebatePatterns = getTenantRebatePatterns(tenant);

    // Cooperative cancel for the revenue-recompute full re-sync — see the
    // invoices path for the rationale. Only armed when fullResync is set.
    class ResyncCancelled extends Error {
      constructor() { super("recompute cancelled"); this.name = "ResyncCancelled"; }
    }
    async function checkCancel(): Promise<boolean> {
      try {
        const [row] = await db.select({ cancel: integrationSyncLogsTable.cancelRequested })
          .from(integrationSyncLogsTable)
          .where(eq(integrationSyncLogsTable.id, syncLog.id))
          .limit(1);
        return row?.cancel === true;
      } catch {
        return false;
      }
    }

    const [fallbackUser] = await db.select({ id: sql<number>`id` })
      .from(sql`users`)
      .where(sql`tenant_id = ${tenantId}`)
      .limit(1);
    const fallbackUserId = fallbackUser?.id ?? 1;

    async function processEstimateBatch(estimates: STEstimate[]) {
      for (const estimate of estimates) {
        const parsed = parseEstimateData(estimate, rebatePatterns);
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
              rebateBreakdown: parsed.rebateBreakdown,
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
            rebateBreakdown: parsed.rebateBreakdown,
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

      // Publish the running tally during a full re-sync so the recompute
      // progress poll reflects estimates being reprocessed live (see the
      // invoices path above for the rationale).
      if (options?.fullResync) {
        await updateSyncLogRecords(syncLog.id, synced);

        // Cooperative cancel check at the batch boundary (see invoices path).
        if (await checkCancel()) {
          cancelled = true;
          throw new ResyncCancelled();
        }
      }
    }

    // On a full re-sync, capture the upstream total-count once so the
    // recompute card can show a percent-complete bar (see invoices path).
    const onEstimateTotal = options?.fullResync
      ? (total: number) => { void updateSyncLogTotalRecords(syncLog.id, total); }
      : undefined;
    try {
      await fetchSoldEstimates(stConfig, modifiedOnOrAfter, processEstimateBatch, onEstimateTotal);
    } catch (innerErr) {
      if (!(innerErr instanceof ResyncCancelled)) throw innerErr;
    }

    if (cancelled) {
      await completeSyncLog(syncLog.id, "cancelled", synced, `Cancelled by operator (${synced} estimates processed)`);
      console.log(`[Sync] ServiceTitan estimates: cancelled after ${synced} sold estimates for tenant ${tenantId}`);
      return { synced, error: "cancelled" };
    }

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

  // Periodic orphan-reaper sweep. The startup reaper (src/index.ts) only runs
  // at boot, so a worker that dies silently while the process stays up (OOM on
  // a single task, an unhandled rejection in a backfill loop) leaves its
  // sync_log stuck at status='running' until the next restart. This sweep
  // recovers those orphans while the server is still alive.
  //
  // The threshold is deliberately FAR more conservative than the 15-min
  // startup reaper: at startup the previous process is definitely dead, but
  // here the process is live and a legitimate backfill may still be churning.
  // We only reap rows whose started_at is older than this long threshold so a
  // genuinely in-flight backfill is never killed. Both interval and threshold
  // are env-overridable.
  const orphanReaperIntervalMs = Number(process.env.ORPHAN_REAPER_INTERVAL_MS || String(30 * 60 * 1000));
  const orphanReaperStaleMinutes = Number(process.env.ORPHAN_REAPER_STALE_MINUTES || "360");
  const orphanReaperTimer = setInterval(async () => {
    try {
      const { reapOrphanedSyncLogs } = await import("./orphan-sync-reaper");
      const reaped = await reapOrphanedSyncLogs(orphanReaperStaleMinutes, "periodic reaper sweep");
      if (reaped > 0) {
        console.log(`[SyncScheduler] Periodic orphan reaper flipped ${reaped} stuck sync_log row(s) to error`);
      }
    } catch (err) {
      console.error("[SyncScheduler] Periodic orphan reaper failed:", err);
    }
  }, orphanReaperIntervalMs);

  // CallRail intake is webhook-only (POST /api/webhooks/callrail/:tenantId).
  // The previous polling backstop was a permanent no-op timer; it has been
  // removed. If CallRail webhooks ever need a polling safety net,
  // re-enable syncCallRailCalls here on a real interval.

  syncTimers = [jobsTimer, campaignTimer, metaTimer, invoiceTimer, reviewTimer, orphanReaperTimer];
  console.log(`[SyncScheduler] Started: ST jobs 15min, Google Ads 60min, Meta nightly @${metaSyncHourEt}:00 ET, invoices+estimates 15min, Podium PAUSED, CallRail webhook-only, orphan reaper ${Math.round(orphanReaperIntervalMs / 60000)}min (stale > ${orphanReaperStaleMinutes}min)`);
}

export function stopSyncScheduler() {
  for (const timer of syncTimers) {
    clearInterval(timer);
  }
  syncTimers = [];
}
