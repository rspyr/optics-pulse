import { db, tenantsTable, jobsTable, leadsTable, attributionEventsTable, campaignsTable, campaignDailyStatsTable, integrationSyncLogsTable, soldEstimatesTable, callAttemptsTable, metaAdsTable, metaAdSetsTable, metaAdDailyStatsTable } from "@workspace/db";
import { emitSyncFailureNotification, emitSyncCatchupNotification } from "./notifications";
import { eq, and, isNull, isNotNull, sql, desc, or, type SQL } from "drizzle-orm";
import { decryptConfig } from "../lib/encryption";
import { SERVICE_TITAN_JOB_STATUSES, SERVICE_TITAN_ESTIMATE_STATUSES, fetchJobsByStatuses, formatSTJobForSync, fetchJobCanceledLog, getServiceTitanJobCancelledAt, fetchCustomerContactsById, fetchLocationsByIds, formatLocationAddress, fetchInvoices, parseInvoiceData, fetchSoldEstimates, parseEstimateData, resolveEmployeeName, clearEmployeeCache, compileRebatePatterns, DEFAULT_REBATE_LABELS, hashStJobId, type STJob, type STInvoice, type STEstimate } from "./integrations/service-titan";
import { fetchCampaignPerformance, formatCampaignRow } from "./integrations/google-ads";
import { MetaAPIService, MetaTokenInvalidError, parseNumericField, parseIntField, sumConversionActions, type MetaAction } from "./integrations/meta";
import { syncPodiumReviews } from "./integrations/podium";
import { DEFAULT_CALLRAIL_SYNC_DAYS, syncCallRailCalls } from "./integrations/callrail";
import { runReconciliation } from "./reconciliation";
import { hashPhone, normalizePhone, phoneMatchesSql } from "../lib/phone-utils";
import { classifyBackfillError } from "./backfill-status-format";
import { DEFAULT_INACTIVITY_STALE_MINUTES } from "./orphan-sync-reaper";
import { createGuardedRunner } from "../lib/reentrancy-guard";
import { getChallengeJobAttributionAt, getLeadSearchWindowForJob } from "./challenge-job-attribution";

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
  callRailCreatePulseLeads?: boolean;
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

function isSoldEstimateStatus(status: string | null | undefined): boolean {
  return status?.trim().toLowerCase() === "sold";
}

// `formatSTJobForSync` writes `Customer <id>` as the customer name when
// ServiceTitan returned no customer object for a job. That placeholder is not a
// real name, so the invoice merge treats it as missing and lets the invoice's
// inline customer name override it (Task #825).
function isPlaceholderCustomerName(name: string | null | undefined): boolean {
  if (!name) return true;
  return /^Customer\s+\d+$/.test(name.trim());
}

type ServiceTitanSyncConfig = {
  clientId: string;
  clientSecret: string;
  tenantId: string;
  appKey?: string;
};

function createServiceTitanJobFormatter(stConfig: ServiceTitanSyncConfig, tenantId: number) {
  let warnedCancelLogFailure = false;

  return async function formatJob(stJob: STJob): Promise<ReturnType<typeof formatSTJobForSync>> {
    const formatted = formatSTJobForSync(stJob);
    if (formatted.status !== "cancelled") return formatted;

    try {
      const canceledLog = await fetchJobCanceledLog(stConfig, stJob.id);
      return {
        ...formatted,
        stCancelledAt: getServiceTitanJobCancelledAt(stJob, canceledLog) ?? formatted.stCancelledAt,
      };
    } catch (err) {
      if (!warnedCancelLogFailure) {
        warnedCancelLogFailure = true;
        console.warn(
          `[ServiceTitan] Tenant ${tenantId}: failed to fetch canceled-log; using canceled job fallback dates. ${(err as Error).message}`,
        );
      }
      return formatted;
    }
  };
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
      progressChunkRecords: null,
      // Clear the in-flight phase label too so a finished row doesn't keep
      // showing "saving results" (or whatever phase it died in).
      progressPhase: null,
    })
    .where(eq(integrationSyncLogsTable.id, logId));
}

/**
 * Throttle for the mid-chunk liveness heartbeat (see `heartbeatSyncLogProgress`
 * and the Meta async backfill poll loop). The async report polls every ~5s, but
 * we don't need a DB write that often — stamping at most once per 30s keeps the
 * worst-case inter-progress gap to ~30s (well under the reaper threshold) while
 * holding write volume to ~2/min per in-flight chunk.
 */
export const HEARTBEAT_MIN_INTERVAL_MS = 30_000;

/**
 * Cooperative-cancel poll cadence for synchronous backfill upsert loops. The
 * in-flight progress flush is throttled to `HEARTBEAT_MIN_INTERVAL_MS` (~30s)
 * to keep write volume low, but a cancel only needs a single cheap read, so it
 * polls on this much tighter cadence. This makes a cancel feel near-instant
 * even inside an unusually large single chunk without adding per-row reads:
 * worst case is one extra `SELECT cancel_requested` every few seconds.
 */
export const CANCEL_POLL_MIN_INTERVAL_MS = 3_000;

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
  // Initial phase label for the new chunk. The Meta async backfill always
  // starts a chunk by generating the async report, so it passes "generating
  // report" here; the synchronous Google Ads backfill has no phases and
  // passes nothing, leaving the column null. Set on the existing chunk-start
  // write so the phase is correct from the first moment of the chunk without
  // an extra DB round-trip.
  phase?: string | null,
  // Optional sub-chunk row progress. When a writer knows how many rows the
  // current chunk holds (`chunkTotalRecords`) and how many it has upserted so
  // far (`chunkRecords`), it passes them here so the /sync-status route can
  // advance the percent *within* a chunk instead of only at chunk boundaries.
  //
  // These columns are *always* written (defaulting to null) so they reset on
  // every chunk-start write. If we only wrote them when provided, a prior
  // chunk's sub-chunk counters would linger into the next chunk's fetch phase
  // (and into zero-row chunks that never reach the "saving results" seed),
  // letting `/sync-status` blend a stale fraction and inflate — or even
  // regress — the percent across chunk boundaries. Writers that don't report
  // sub-chunk progress (Meta / ServiceTitan) leave both null, so the percent
  // falls back to the chunk-ordinal estimate exactly as before.
  chunkRecords: number | null = null,
  chunkTotalRecords: number | null = null,
) {
  const set = {
    recordsProcessed,
    progressCurrentChunk: currentChunk,
    progressTotalChunks: totalChunks,
    progressWindowStart: windowStart,
    progressWindowEnd: windowEnd,
    progressPhase: phase ?? null,
    // Stamp inactivity watermark so the orphan reaper keeps this long-running
    // backfill alive while it's making progress, and reaps it once it stops.
    // Also surfaced as "last progress N min ago" in the Settings panel.
    progressUpdatedAt: new Date(),
    errorMessage: null,
    errorCode: null,
    partial: false,
    progressChunkRecords: chunkRecords,
    progressTotalRecords: chunkTotalRecords,
  };
  await db.update(integrationSyncLogsTable)
    .set(set)
    .where(eq(integrationSyncLogsTable.id, logId));
}

/**
 * Record in-flight row progress for a running sync log without any chunk
 * metadata. Used by the full re-sync (revenue recompute) path so the
 * Settings panel can poll `recordsProcessed` and show live progress while
 * invoices / estimates are being reprocessed batch-by-batch. We don't touch
 * the chunk columns here — those are reserved for windowed backfills.
 *
 * An optional human-readable `phase` (e.g. "reprocessing invoices") is
 * piggybacked onto this same per-batch watermark write — surfacing what stage
 * the recompute is in costs no extra DB write volume (same pattern as the
 * backfill heartbeat). When `phase` is omitted the column is left untouched.
 */
async function updateSyncLogRecords(logId: number, recordsProcessed: number, phase?: string) {
  const set: { recordsProcessed: number; progressUpdatedAt: Date; progressPhase?: string } = {
    recordsProcessed,
    // Stamp inactivity watermark so the orphan reaper treats a row that's still
    // publishing record progress as alive (see updateSyncLogChunkProgress).
    progressUpdatedAt: new Date(),
  };
  if (phase !== undefined) set.progressPhase = phase;
  await db.update(integrationSyncLogsTable)
    .set(set)
    .where(eq(integrationSyncLogsTable.id, logId));
}

/**
 * Lightweight liveness heartbeat: stamps ONLY `progress_updated_at` on a
 * running sync log, leaving every other column untouched. Used mid-chunk by
 * the Meta async backfill so a healthy-but-slow chunk — whose only structural
 * progress write (`updateSyncLogChunkProgress`) happens at chunk start —
 * keeps publishing an inactivity watermark while the async report polls. This
 * shrinks the worst-case inter-stamp gap from a whole chunk (~5 min) to the
 * heartbeat interval, so the orphan reaper threshold and the UI "Stalled"
 * badge can both be tightened without false-positiving on live runs.
 */
export async function heartbeatSyncLogProgress(logId: number, phase?: string) {
  // Piggyback the human-readable phase onto the same throttled write that
  // already stamps the inactivity watermark — so surfacing "what is this run
  // doing" costs no extra DB write volume. When `phase` is omitted we leave
  // the column untouched (pure liveness watermark, as before).
  const set: { progressUpdatedAt: Date; progressPhase?: string } = {
    progressUpdatedAt: new Date(),
  };
  if (phase !== undefined) set.progressPhase = phase;
  await db.update(integrationSyncLogsTable)
    .set(set)
    .where(eq(integrationSyncLogsTable.id, logId));
}

/**
 * Build the `onPollHeartbeat` callback handed to `fetchAdDailyInsightsAsync`.
 * Encapsulates the two pieces of "heartbeat wiring" that keep a long async
 * chunk looking alive to the orphan reaper / UI:
 *
 *   1. Throttle — the async report polls every ~5s, but we stamp at most once
 *      per `HEARTBEAT_MIN_INTERVAL_MS` so write volume stays ~2/min per chunk
 *      while still bounding the worst-case inter-stamp gap to ~30s.
 *   2. Failure isolation — a heartbeat is pure liveness bookkeeping, so a DB
 *      write hiccup must NEVER abort an otherwise-healthy backfill; the write
 *      is awaited (so a slow write back-pressures rather than races the loop)
 *      but any thrown error is swallowed.
 *
 * `writer` and `now` are injectable purely so the wiring can be unit-tested
 * (throttle timing + error swallowing) without a live poll loop or a real DB.
 */
export function makePollHeartbeat(
  logId: number,
  writer: (id: number) => Promise<void> = heartbeatSyncLogProgress,
  now: () => number = Date.now,
): () => Promise<void> {
  let lastHeartbeatAt = now();
  return async () => {
    const t = now();
    if (t - lastHeartbeatAt < HEARTBEAT_MIN_INTERVAL_MS) return;
    lastHeartbeatAt = t;
    try {
      await writer(logId);
    } catch {
      /* liveness-only: a heartbeat write failure must not abort the backfill */
    }
  };
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
      progressUpdatedAt: new Date(),
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
    stJobOriginAt: jobsTable.stJobOriginAt,
    completedAt: jobsTable.completedAt,
    createdAt: jobsTable.createdAt,
    status: jobsTable.status,
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

    const jobAttributionAt = getChallengeJobAttributionAt(job);
    if (!jobAttributionAt) continue;

    const { earliestLeadAt, latestLeadAt } = getLeadSearchWindowForJob(jobAttributionAt);
    matchConditions.push(sql`${leadsTable.createdAt} >= ${earliestLeadAt}`);
    matchConditions.push(sql`${leadsTable.createdAt} <= ${latestLeadAt}`);

    const [lead] = await db.select({ id: leadsTable.id })
      .from(leadsTable)
      .where(and(...matchConditions))
      .orderBy(
        sql`CASE WHEN ${leadsTable.createdAt} <= ${jobAttributionAt} THEN 0 ELSE 1 END`,
        desc(leadsTable.createdAt),
      )
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

export async function matchJobsToCallRailAttribution(
  tenantId: number,
  options: { days?: number } = {},
): Promise<{ matched: number; golden: number; silver: number }> {
  const lookbackDays = Math.max(options.days ?? DEFAULT_CALLRAIL_SYNC_DAYS, 90);
  const lookbackDate = new Date(Date.now() - lookbackDays * 86400000);

  const jobs = await db.select({
    id: jobsTable.id,
    customerPhone: jobsTable.customerPhone,
  }).from(jobsTable).where(and(
    eq(jobsTable.tenantId, tenantId),
    eq(jobsTable.status, "completed"),
    sql`${jobsTable.completedAt} >= ${lookbackDate}`,
    or(isNull(jobsTable.matchLevel), eq(jobsTable.matchLevel, "unmatched")),
    isNotNull(jobsTable.customerPhone),
  ));

  let matched = 0;
  let golden = 0;

  for (const job of jobs) {
    if (!job.customerPhone) continue;
    const jobHashedPhone = hashPhone(job.customerPhone);
    const [event] = await db.select({
      id: attributionEventsTable.id,
      gclid: attributionEventsTable.gclid,
      createdLeadId: attributionEventsTable.createdLeadId,
    }).from(attributionEventsTable)
      .where(and(
        eq(attributionEventsTable.tenantId, tenantId),
        eq(attributionEventsTable.eventType, "call"),
        eq(attributionEventsTable.hashedPhone, jobHashedPhone),
        sql`${attributionEventsTable.externalId} LIKE 'callrail:%'`,
        sql`${attributionEventsTable.createdAt} >= ${lookbackDate}`,
      ))
      .orderBy(desc(attributionEventsTable.createdAt))
      .limit(1);

    if (!event) continue;

    await db.execute(sql`
      UPDATE jobs
      SET
        lead_id = coalesce(lead_id, ${event.createdLeadId ?? null}),
        match_level = 'golden',
        matched_gclid = ${event.gclid ?? null},
        updated_at = now()
      WHERE id = ${job.id}
    `);
    await db.update(attributionEventsTable)
      .set({ matchLevel: "golden", matchConfidence: 0.9 })
      .where(eq(attributionEventsTable.id, event.id));

    matched++;
    golden++;
  }

  const silver = 0;

  if (matched > 0) {
    console.log(`[CallRail] Matched ${matched} job(s) to CallRail attribution for tenant ${tenantId} (${golden} golden, ${silver} silver)`);
  }

  return { matched, golden, silver };
}

export async function syncCallRailAttribution(
  tenantId: number,
  options: {
    days?: number;
    syncType?: "calls" | "backfill";
    createLeadMode?: "active" | "attribution_only" | "none";
  } = {},
): Promise<{ synced: number; newCalls: number; updatedCalls: number; error?: string }> {
  const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId));
  if (!tenant) return { synced: 0, newCalls: 0, updatedCalls: 0, error: "Tenant not found" };

  const syncType = options.syncType ?? "calls";
  const config = getTenantConfig(tenant);
  if (!config?.callRailApiKey || !config.callRailAccountId) {
    const missing = [
      !config?.callRailApiKey && "API Key",
      !config?.callRailAccountId && "Account ID",
    ].filter(Boolean).join(", ");
    const errorMessage = `CallRail not configured (missing: ${missing})`;
    const missingLog = await logSync(tenantId, "callrail", syncType, new Date());
    await completeSyncLog(missingLog.id, "error", 0, errorMessage);
    return { synced: 0, newCalls: 0, updatedCalls: 0, error: errorMessage };
  }

  const lockResult = await db.execute(sql`SELECT pg_try_advisory_lock(${0x43414c52}, ${tenantId}) AS got`);
  const gotLock = (lockResult.rows[0] as { got: boolean } | undefined)?.got === true;
  if (!gotLock) {
    const errorMessage = "Another CallRail sync is already running for this tenant";
    const lockLog = await logSync(tenantId, "callrail", syncType, new Date());
    await completeSyncLog(lockLog.id, "error", 0, errorMessage);
    return { synced: 0, newCalls: 0, updatedCalls: 0, error: errorMessage };
  }

  try {
    const createLeadMode = options.createLeadMode === "attribution_only"
      ? "none"
      : options.createLeadMode ?? (
          syncType === "backfill"
            ? "none"
            : config.callRailCreatePulseLeads === true ? "active" : "none"
        );
    const result = await syncCallRailCalls(tenantId, {
      apiKey: config.callRailApiKey,
      accountId: config.callRailAccountId,
      companyId: config.callRailCompanyId,
    }, {
      days: options.days,
      syncType,
      createLeadMode,
    });

    if (result.synced > 0) {
      try {
        await matchJobsToCallRailAttribution(tenantId, { days: options.days });
      } catch (err) {
        console.error(`[CallRail] Post-sync attribution matching failed for tenant ${tenantId}:`, (err as Error).message);
      }
    }

    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try { await emitSyncFailureNotification(tenantId, "callrail", message); } catch {}
    return { synced: 0, newCalls: 0, updatedCalls: 0, error: message };
  } finally {
    try {
      await db.execute(sql`SELECT pg_advisory_unlock(${0x43414c52}, ${tenantId})`);
    } catch (unlockErr) {
      console.error(`[CallRail] Tenant ${tenantId}: failed to release advisory lock`, unlockErr);
    }
  }
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
  // this the scheduled sync calls ServiceTitan with no date filter,
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
  // rolling fallback window, the in-flight ServiceTitan page cap can
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
    const formatJobForDb = createServiceTitanJobFormatter(stConfig, tenantId);

    let synced = 0;

    async function processJobBatch(stJobs: STJob[]) {
      for (const stJob of stJobs) {
        const formatted = await formatJobForDb(stJob);
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
          // A purged row is detected by its internal ST job id being nulled.
          // customerName can NO LONGER be used as the purge marker (Task #819
          // retains it indefinitely), so keying off it would misclassify purged
          // rows as live and rehydrate phone/email/internal ids on re-sync.
          const wasPurged = existing.stJobId === null;
          if (wasPurged) {
            await db.update(jobsTable)
              .set({
                revenue: formatted.revenue,
                status: formatted.status,
                completedAt: formatted.completedAt,
                stJobOriginAt: formatted.stJobOriginAt,
                stCancelledAt: formatted.stCancelledAt,
                jobTypeName: formatted.jobTypeName || existing.jobTypeName,
                businessUnit: formatted.businessUnit || existing.businessUnit,
                // Job number is a reference (not PII) and is never purged, so
                // refresh it even on an otherwise-purged row (Task #819).
                stJobNumber: formatted.stJobNumber || existing.stJobNumber,
                updatedAt: new Date(),
              })
              .where(eq(jobsTable.id, existing.id));
          } else {
            await db.update(jobsTable)
              .set({
                revenue: formatted.revenue,
                status: formatted.status,
                completedAt: formatted.completedAt,
                stJobOriginAt: formatted.stJobOriginAt,
                stCancelledAt: formatted.stCancelledAt,
                customerName: formatted.customerName,
                customerPhone: formatted.customerPhone || existing.customerPhone,
                customerEmail: formatted.customerEmail || existing.customerEmail,
                serviceAddress: formatted.serviceAddress || existing.serviceAddress,
                stJobNumber: formatted.stJobNumber || existing.stJobNumber,
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

    await fetchJobsByStatuses(stConfig, SERVICE_TITAN_JOB_STATUSES, modifiedOnOrAfter, processJobBatch);

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
  opts?: {
    /**
     * Liveness heartbeat fired between DB batches while writing rows. For a
     * very large chunk the ad-day insert loop, per-campaign upsert loop, and
     * stat insert loop can each take minutes — long after the async report's
     * poll/page heartbeats have stopped. Stamping here keeps the run alive
     * through the upsert phase. Awaited so a slow write back-pressures the
     * loop; the caller swallows thrown errors so a heartbeat hiccup never
     * aborts a live backfill.
     */
    onProgress?: () => void | Promise<void>;
  },
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
    if (opts?.onProgress) await opts.onProgress();
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
    if (opts?.onProgress) await opts.onProgress();
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
    if (opts?.onProgress) await opts.onProgress();
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
    let cancelledAt: { chunkIdx: number; rows: number } | null = null;

    // Cooperative cancel sentinel — mirrors the Google Ads / ServiceTitan
    // backfill pattern. A Meta chunk spends most of its time inside async
    // operations (report poll, paging, upsert) that take callbacks, so we
    // poll the cancel flag from inside those callbacks and throw this to
    // unwind out of them. The outer catch distinguishes it from a real
    // upstream error by checking `cancelledAt`.
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

    try {
      for (let i = 0; i < chunks.length; i++) {
        // Cancel check at chunk boundary — cheap and frequent enough that a
        // user clicking Cancel sees a response within seconds, not minutes.
        if (await checkCancel()) {
          cancelledAt = { chunkIdx: i, rows: totalSynced };
          break;
        }
        const { since, until } = chunks[i];
        await updateSyncLogChunkProgress(
          syncLog.id,
          totalSynced,
          i + 1,
          chunks.length,
          since,
          until,
          // A chunk always begins by generating the async report, so seed the
          // phase here on the existing chunk-start write. The throttled beat
          // below advances it through paging → saving as the chunk proceeds.
          "generating report",
        );
        // Task #561: route historical chunks through Meta's async report
        // endpoint. Async reports are tracked against a separate per-app
        // budget from synchronous `/insights` calls, so heavy multi-month
        // backfills no longer starve the nightly sync's per-user quota.
        // `MetaTokenInvalidError` still bubbles through unchanged so the
        // reconnect-flag logic from Task #556 keeps working.
        //
        // Mid-chunk heartbeat: a single chunk stays slow across three phases
        // long after `updateSyncLogChunkProgress` (above) — the async report
        // polls for minutes, paging the completed report can run up to the
        // 200-page cap, and the upsert loops can take minutes on a large
        // chunk. Stamp a lightweight liveness watermark from inside all three,
        // throttled to `HEARTBEAT_MIN_INTERVAL_MS` via a shared timestamp so we
        // never exceed ~2 writes/min regardless of which phase is running. A
        // heartbeat write failure must never abort a live backfill, so it's
        // swallowed.
        let lastHeartbeatAt = Date.now();
        // Current phase of the chunk, advanced by whichever callback is firing.
        // The throttled `beat` writes this label alongside the liveness
        // watermark, so the phase rides the existing heartbeat write — no extra
        // DB write volume. Seeded to match the chunk-start write above; the
        // page/save callbacks bump it as the chunk moves through its phases.
        let phase = "generating report";
        const beat = async () => {
          const now = Date.now();
          if (now - lastHeartbeatAt < HEARTBEAT_MIN_INTERVAL_MS) return;
          lastHeartbeatAt = now;
          try { await heartbeatSyncLogProgress(syncLog.id, phase); } catch {}
        };
        // Cooperative cancel poll on its own tight cadence
        // (`CANCEL_POLL_MIN_INTERVAL_MS`, a few seconds), decoupled from the
        // ~30s heartbeat throttle above. A single chunk can spend minutes in
        // the async report poll, paging, or the upsert loop, so we piggyback
        // the cancel check on the same callbacks that drive the heartbeat but
        // gate it on its own clock. A cancel is a single cheap
        // `SELECT cancel_requested`, so polling it far more often than we
        // flush progress keeps a large chunk stoppable mid-flight within a few
        // seconds (not up to ~30s) while still adding no per-row reads. Throw
        // to unwind out of whichever async op is running; the outer catch
        // treats `BackfillCancelled` as the expected cancel path, not a
        // failure. Kept outside `beat`'s swallow-on-error try so the throw
        // actually propagates.
        let lastCancelCheckAt = Date.now();
        const pollCancel = async () => {
          const now = Date.now();
          if (now - lastCancelCheckAt < CANCEL_POLL_MIN_INTERVAL_MS) return;
          lastCancelCheckAt = now;
          if (await checkCancel()) {
            cancelledAt = { chunkIdx: i, rows: totalSynced };
            throw new BackfillCancelled();
          }
        };
        const insights = await svc.fetchAdDailyInsightsAsync(since, until, {
          onPollHeartbeat: async () => { phase = "generating report"; await beat(); await pollCancel(); },
          onPageHeartbeat: async () => { phase = "downloading results"; await beat(); await pollCancel(); },
        });
        const { perAdSynced } = await upsertMetaInsightRows(tenantId, accountIdNoPrefix, currency, insights, {
          onProgress: async () => { phase = "saving results"; await beat(); await pollCancel(); },
        });
        totalSynced += perAdSynced;
        console.log(`[Backfill] Meta tenant ${tenantId} chunk ${i + 1}/${chunks.length} ${since}→${until}: ${perAdSynced} ad-day rows (async, ${svc.requestCount} requests so far)`);
      }
    } catch (innerErr) {
      // BackfillCancelled is an expected unwind path, not a partial failure.
      if (innerErr instanceof BackfillCancelled) {
        // fall through to the cancelled-completion path below
      } else {
        // Re-throw so the outer catch handles error-state, but stash partial
        // progress on the log first so operators don't lose visibility into
        // how far the backfill got before failing.
        const innerMessage = innerErr instanceof Error ? innerErr.message : String(innerErr);
        try { await updateSyncLogPartialFailure(syncLog.id, totalSynced, innerMessage); } catch {}
        throw innerErr;
      }
    }

    if (cancelledAt) {
      // Finalize as `cancelled` (not `error`), preserving the rows already
      // upserted — same contract as the Google Ads / ServiceTitan backfill
      // cancel path.
      await completeSyncLog(syncLog.id, "cancelled", totalSynced, `Cancelled by operator after chunk ${cancelledAt.chunkIdx + 1}/${chunks.length} (${totalSynced} rows synced)`);
      console.log(`[Backfill] Meta tenant ${tenantId}: cancelled after ${totalSynced} ad-day rows (chunk ${cancelledAt.chunkIdx + 1}/${chunks.length})`);
      return { synced: totalSynced, chunks: cancelledAt.chunkIdx, error: "cancelled" };
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
    let cancelledAt: { chunkIdx: number; rows: number } | null = null;

    // Cooperative cancel sentinel — mirrors the ServiceTitan backfill pattern.
    // The upsert loop has no batched callback to throw out of, so we break the
    // chunk loop at chunk boundaries and throw this from inside the upsert loop
    // to unwind out of the row iteration. The outer catch distinguishes it from
    // a real upstream error by checking `cancelledAt`.
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

    try {
      for (let i = 0; i < chunks.length; i++) {
        // Cancel check at chunk boundary — cheap and frequent enough that a
        // user clicking Cancel sees a response within seconds, not minutes.
        if (await checkCancel()) {
          cancelledAt = { chunkIdx: i, rows: totalSynced };
          break;
        }
        const { since, until } = chunks[i];
        await updateSyncLogChunkProgress(
          syncLog.id,
          totalSynced,
          i + 1,
          chunks.length,
          since,
          until,
          // Synchronous Google Ads backfill has no async/heartbeat hooks to
          // ride, so its only per-chunk sync-log write is this chunk-start one.
          // Seed the phase here (the chunk always begins by fetching the
          // window's campaign performance) so the Settings panel shows a label
          // alongside progress — no extra DB write volume, same piggyback as the
          // Meta backfill's chunk-start seed.
          "fetching campaigns",
        );

        const rows = await fetchCampaignPerformance(gaConfig, since, until);

        // Fetching is done; the rest of the chunk is the synchronous upsert
        // loop. Advance the phase to "saving results" so the Settings panel
        // reflects what the chunk is actually doing (the Meta/ServiceTitan
        // paths both advance through multiple phases). One write per chunk —
        // negligible volume. Seed the in-flight flush throttle clock here too.
        // `chunkDone`/`rows.length` are reported as sub-chunk row progress so
        // the /sync-status route can advance the percent within this chunk
        // (not just at chunk boundaries). Best-effort: a progress write must
        // never abort the backfill.
        let lastProgressFlushAt = Date.now();
        let lastCancelCheckAt = Date.now();
        let chunkDone = 0;
        if (rows.length > 0) {
          try {
            await updateSyncLogChunkProgress(
              syncLog.id,
              totalSynced,
              i + 1,
              chunks.length,
              since,
              until,
              "saving results",
              chunkDone,
              rows.length,
            );
          } catch {}
        }

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
          chunkDone++;

          // Flush in-flight progress so the row count / percent tick up
          // within a chunk instead of only at chunk boundaries. The sub-chunk
          // counts (`chunkDone`/`rows.length`) let the route render a percent
          // that advances mid-chunk. Throttled to the same ~2/min cap as the
          // Meta heartbeat (HEARTBEAT_MIN_INTERVAL_MS) so this adds no
          // meaningful DB write volume even on large chunks. Best-effort:
          // never let a progress write abort the upsert loop.
          const nowMs = Date.now();
          if (nowMs - lastProgressFlushAt >= HEARTBEAT_MIN_INTERVAL_MS) {
            lastProgressFlushAt = nowMs;
            try {
              await updateSyncLogChunkProgress(
                syncLog.id,
                totalSynced,
                i + 1,
                chunks.length,
                since,
                until,
                "saving results",
                chunkDone,
                rows.length,
              );
            } catch {}
          }

          // Cooperative cancel check on its own tight cadence
          // (`CANCEL_POLL_MIN_INTERVAL_MS`, a few seconds), decoupled from the
          // ~30s progress flush above. A cancel is a single cheap
          // `SELECT cancel_requested`, so polling it far more often than we
          // flush progress keeps a large chunk stoppable mid-upsert within a
          // few seconds (not up to ~30s) while still adding no per-row reads.
          // Throw to unwind out of the row loop; the outer catch treats
          // `BackfillCancelled` as the expected cancel path, not a failure.
          if (nowMs - lastCancelCheckAt >= CANCEL_POLL_MIN_INTERVAL_MS) {
            lastCancelCheckAt = nowMs;
            if (await checkCancel()) {
              cancelledAt = { chunkIdx: i, rows: totalSynced };
              throw new BackfillCancelled();
            }
          }
        }
        console.log(`[Backfill] Google Ads tenant ${tenantId} chunk ${i + 1}/${chunks.length} ${since}→${until}: ${rows.length} campaign-day rows`);
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
      // Finalize as `cancelled` (not `error`), preserving the rows already
      // upserted — same contract as the ServiceTitan backfill cancel path.
      await completeSyncLog(syncLog.id, "cancelled", totalSynced, `Cancelled by operator after chunk ${cancelledAt.chunkIdx + 1}/${chunks.length} (${totalSynced} rows synced)`);
      console.log(`[Backfill] Google Ads tenant ${tenantId}: cancelled after ${totalSynced} campaign-day rows (chunk ${cancelledAt.chunkIdx + 1}/${chunks.length})`);
      return { synced: totalSynced, chunks: cancelledAt.chunkIdx, error: "cancelled" };
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
 * stays well under the per-status page cap inside the ServiceTitan job fetcher.
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
    const formatJobForDb = createServiceTitanJobFormatter(stConfig, tenantId);

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

    // Throw-to-unwind sentinel: the only way to stop the ServiceTitan page walk
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
        const formatted = await formatJobForDb(stJob);
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
          // A purged row is detected by its internal ST job id being nulled.
          // customerName can NO LONGER be used as the purge marker (Task #819
          // retains it indefinitely), so keying off it would misclassify purged
          // rows as live and rehydrate phone/email/internal ids on re-sync.
          const wasPurged = existing.stJobId === null;
          if (wasPurged) {
            await db.update(jobsTable)
              .set({
                revenue: formatted.revenue,
                status: formatted.status,
                completedAt: formatted.completedAt,
                stJobOriginAt: formatted.stJobOriginAt,
                stCancelledAt: formatted.stCancelledAt,
                jobTypeName: formatted.jobTypeName || existing.jobTypeName,
                businessUnit: formatted.businessUnit || existing.businessUnit,
                // Job number is a reference (not PII) and is never purged, so
                // refresh it even on an otherwise-purged row (Task #819).
                stJobNumber: formatted.stJobNumber || existing.stJobNumber,
                updatedAt: new Date(),
              })
              .where(eq(jobsTable.id, existing.id));
          } else {
            await db.update(jobsTable)
              .set({
                revenue: formatted.revenue,
                status: formatted.status,
                completedAt: formatted.completedAt,
                stJobOriginAt: formatted.stJobOriginAt,
                stCancelledAt: formatted.stCancelledAt,
                customerName: formatted.customerName,
                customerPhone: formatted.customerPhone || existing.customerPhone,
                customerEmail: formatted.customerEmail || existing.customerEmail,
                serviceAddress: formatted.serviceAddress || existing.serviceAddress,
                stJobNumber: formatted.stJobNumber || existing.stJobNumber,
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
      // the ServiceTitan page walk. The outer chunk loop catches this and marks
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
        await fetchJobsByStatuses(stConfig, SERVICE_TITAN_JOB_STATUSES, since, processJobBatch, before);
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

        const sorted = jobInvoices.sort((a, b) => {
          const dateA = a.invoiceDate ? new Date(a.invoiceDate).getTime() : 0;
          const dateB = b.invoiceDate ? new Date(b.invoiceDate).getTime() : 0;
          return dateB - dateA;
        });
        const latestInvoice = parseInvoiceData(sorted[0], rebatePatterns);

        const [directExistingJob] = await db.select({
            id: jobsTable.id,
            stInvoiceId: jobsTable.stInvoiceId,
            stJobId: jobsTable.stJobId,
            stJobIdHash: jobsTable.stJobIdHash,
            stJobNumber: jobsTable.stJobNumber,
            stCustomerId: jobsTable.stCustomerId,
            stLocationId: jobsTable.stLocationId,
            customerName: jobsTable.customerName,
            serviceAddress: jobsTable.serviceAddress,
          })
          .from(jobsTable)
          .where(and(
            eq(jobsTable.tenantId, tenantId),
            sql`(${jobsTable.stJobId} = ${stJobId} OR ${jobsTable.stJobIdHash} = ${jobIdHash})`,
          ))
          .limit(1);

        let existingJob = directExistingJob ?? null;
        if (!existingJob && latestInvoice.stJobNumber) {
          const byJobNumber = await db.select({
              id: jobsTable.id,
              stInvoiceId: jobsTable.stInvoiceId,
              stJobId: jobsTable.stJobId,
              stJobIdHash: jobsTable.stJobIdHash,
              stJobNumber: jobsTable.stJobNumber,
              stCustomerId: jobsTable.stCustomerId,
              stLocationId: jobsTable.stLocationId,
              customerName: jobsTable.customerName,
              serviceAddress: jobsTable.serviceAddress,
            })
            .from(jobsTable)
            .where(and(
              eq(jobsTable.tenantId, tenantId),
              eq(jobsTable.stJobNumber, latestInvoice.stJobNumber),
            ))
            .limit(2);
          if (byJobNumber.length === 1) {
            existingJob = byJobNumber[0];
          }
        }

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

        if (!existingJob) {
          // Invoice-only job: the completed-jobs sync never created a row for it
          // (e.g. the job isn't in a "Completed" status, or its row was wiped).
          // The invoice carries enough to make it appear in revenue attribution,
          // so create the row authoritatively from the invoice rather than
          // dropping the data on the floor (Task #825). Revenue is left at 0 —
          // corrected revenue is derived from invoiceTotal + rebate downstream.
          await db.insert(jobsTable).values({
            tenantId,
            stJobId,
            stJobIdHash: jobIdHash,
            stJobNumber: latestInvoice.stJobNumber,
            customerName: latestInvoice.customerName,
            serviceAddress: latestInvoice.serviceAddress,
            // Persist the internal customer + location ids the invoice carries so
            // the contact-enrichment pass (which keys off stCustomerId) can fill
            // phone/email — and the address pass can fill a missing address — on
            // these invoice-only rows before the 24h purge clears the ids (#825).
            stCustomerId: sorted[0].customer?.id ? String(sorted[0].customer.id) : null,
            stLocationId: sorted[0].location?.id ? String(sorted[0].location.id) : null,
            jobType: sorted[0].job?.type || "Service",
            status: "completed",
            revenue: 0,
            hasInvoice: true,
            invoiceTotal: totalInvoiceAmount,
            invoiceRebateAmount: totalRebate,
            invoicePaidAmount: totalPaid > 0 ? totalPaid : 0,
            invoiceBalance: totalBalance,
            stInvoiceId: latestInvoice.stInvoiceId,
            invoiceDate: latestInvoice.invoiceDate,
            invoicePaidOn: latestPaidOn,
            stDataExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          });
          synced++;
          continue;
        }

        // ServiceTitan has no invoice number — the job number is the
        // portal-findable invoice number. Backfill it from the invoice when the
        // job row doesn't already carry one (Task #819). For customer name +
        // service address the invoice is authoritative: it fills a missing value
        // AND overrides the `Customer <id>` placeholder the job sync writes when
        // ServiceTitan returned no customer object, but a real job-enriched
        // value is preserved over the invoice's (Task #825).
        const resolvedJobNumber =
          existingJob.stJobNumber || latestInvoice.stJobNumber || null;
        const resolvedCustomerName =
          isPlaceholderCustomerName(existingJob.customerName)
            ? (latestInvoice.customerName || existingJob.customerName || null)
            : existingJob.customerName;
        const resolvedServiceAddress =
          existingJob.serviceAddress || latestInvoice.serviceAddress || null;
        const invoiceCustomerId = sorted[0].customer?.id ? String(sorted[0].customer.id) : null;
        const invoiceLocationId = sorted[0].location?.id ? String(sorted[0].location.id) : null;
        const refreshedInternalIds =
          !existingJob.stJobId ||
          !existingJob.stJobIdHash ||
          (!existingJob.stCustomerId && !!invoiceCustomerId) ||
          (!existingJob.stLocationId && !!invoiceLocationId);

        await db.update(jobsTable)
          .set({
            stJobId: existingJob.stJobId || stJobId,
            stJobIdHash: existingJob.stJobIdHash || jobIdHash,
            stCustomerId: existingJob.stCustomerId || invoiceCustomerId,
            stLocationId: existingJob.stLocationId || invoiceLocationId,
            hasInvoice: true,
            invoiceTotal: totalInvoiceAmount,
            invoiceRebateAmount: totalRebate,
            invoicePaidAmount: totalPaid > 0 ? totalPaid : 0,
            invoiceBalance: totalBalance,
            stInvoiceId: latestInvoice.stInvoiceId,
            stJobNumber: resolvedJobNumber,
            customerName: resolvedCustomerName,
            serviceAddress: resolvedServiceAddress,
            invoiceDate: latestInvoice.invoiceDate,
            invoicePaidOn: latestPaidOn,
            ...(refreshedInternalIds ? { stDataExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) } : {}),
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
        await updateSyncLogRecords(syncLog.id, synced, "reprocessing invoices");

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

        const estimateIsSold = isSoldEstimateStatus(parsed.estimateStatus);
        const wasUnlinked = existing && !existing.leadId;
        const nowLinked = !!matchedLeadId;

        if (existing) {
          await db.update(soldEstimatesTable)
            .set({
              jobId: matchedJobId,
              leadId: matchedLeadId,
              stJobId: parsed.stJobId,
              estimateName: parsed.estimateName,
              estimateStatus: parsed.estimateStatus,
              summary: parsed.summary,
              stEstimateCreatedAt: parsed.stEstimateCreatedAt,
              followUpOn: parsed.followUpOn,
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

          if (estimateIsSold && wasUnlinked && nowLinked && matchedLeadId) {
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
            estimateName: parsed.estimateName,
            estimateStatus: parsed.estimateStatus,
            summary: parsed.summary,
            stEstimateCreatedAt: parsed.stEstimateCreatedAt,
            followUpOn: parsed.followUpOn,
            soldByName,
            soldByStEmployeeId: parsed.soldByEmployeeId,
            soldOn: parsed.soldOn,
            subtotal: parsed.subtotal,
            rebateAmount: parsed.rebateAmount,
            totalAmount: parsed.totalAmount,
            rebateBreakdown: parsed.rebateBreakdown,
          });

          if (estimateIsSold && matchedLeadId) {
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

        if (estimateIsSold && matchedLeadId) {
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
        await updateSyncLogRecords(syncLog.id, synced, "reprocessing estimates");

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
      await fetchSoldEstimates(stConfig, modifiedOnOrAfter, processEstimateBatch, onEstimateTotal, { status: SERVICE_TITAN_ESTIMATE_STATUSES });
    } catch (innerErr) {
      if (!(innerErr instanceof ResyncCancelled)) throw innerErr;
    }

    if (cancelled) {
      await completeSyncLog(syncLog.id, "cancelled", synced, `Cancelled by operator (${synced} estimates processed)`);
      console.log(`[Sync] ServiceTitan estimates: cancelled after ${synced} estimates for tenant ${tenantId}`);
      return { synced, error: "cancelled" };
    }

    await completeSyncLog(syncLog.id, "completed", synced);
    console.log(`[Sync] ServiceTitan estimates: synced ${synced} estimates for tenant ${tenantId}`);
    return { synced };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await completeSyncLog(syncLog.id, "error", 0, message);
    console.error(`[Sync] ServiceTitan estimates error for tenant ${tenantId}:`, message);
    try { await emitSyncFailureNotification(tenantId, "service_titan", message); } catch {}
    return { synced: 0, error: message };
  }
}

export interface RecomputeRevenueResult {
  invoices: { synced: number; error?: string };
  estimates: { synced: number; error?: string };
  /** True when another recompute already held the lock, so this call was a
   *  no-op (coalesced). The caller can surface a 409 / log instead of
   *  stacking a duplicate full re-sync. */
  alreadyRunning?: boolean;
  /** True when the operator cancelled mid-run (invoices or estimates phase). */
  cancelled?: boolean;
}

/**
 * Run the historical revenue recompute (full re-sync of invoices then
 * estimates) for a tenant under a per-tenant advisory lock so concurrent
 * triggers can't stack overlapping full re-syncs.
 *
 * This is the single shared guard for BOTH recompute triggers: the
 * auto-trigger after a rebate-label change (PATCH /tenants/:id) and the manual
 * recompute-revenue route. Saving the rebate list several times in quick
 * succession — or saving while a manual recompute is already in flight —
 * previously fired multiple uncoordinated full re-syncs, doubling ServiceTitan
 * API load and racing on the same invoice/estimate/job row updates.
 *
 * Uses a DEDICATED lock key (0x53545256 = 'STRV', ServiceTitan ReVenue),
 * distinct from the STAN jobs lock (0x5354414e): the scheduled jobs sync nests
 * an incremental invoice sync inside the STAN lock, so reusing STAN here would
 * either be refused (pooled connection mismatch) or deadlock. The incremental
 * 15-min invoice/estimate sync is intentionally NOT gated by this lock — only
 * the heavyweight full re-sync path is.
 */
export async function recomputeServiceTitanRevenue(tenantId: number): Promise<RecomputeRevenueResult> {
  const lockResult = await db.execute(sql`SELECT pg_try_advisory_lock(${0x53545256}, ${tenantId}) AS got`);
  const gotLock = (lockResult.rows[0] as { got: boolean } | undefined)?.got === true;
  if (!gotLock) {
    const message = "A revenue recompute is already running for this tenant";
    return {
      alreadyRunning: true,
      invoices: { synced: 0, error: message },
      estimates: { synced: 0, error: "skipped" },
    };
  }

  try {
    const invoices = await syncServiceTitanInvoices(tenantId, { fullResync: true });
    if (invoices.error === "cancelled") {
      return { invoices, estimates: { synced: 0, error: "skipped" }, cancelled: true };
    }
    const estimates = await syncServiceTitanEstimates(tenantId, { fullResync: true });
    if (estimates.error === "cancelled") {
      return { invoices, estimates, cancelled: true };
    }
    return { invoices, estimates };
  } finally {
    try {
      await db.execute(sql`SELECT pg_advisory_unlock(${0x53545256}, ${tenantId})`);
    } catch (unlockErr) {
      console.error(`[Recompute] ServiceTitan tenant ${tenantId}: failed to release advisory lock`, unlockErr);
    }
  }
}

let syncTimers: ReturnType<typeof setInterval>[] = [];

export function startSyncScheduler() {
  stopSyncScheduler();

  const jobsSyncInterval = 15 * 60 * 1000;
  const campaignSyncInterval = 60 * 60 * 1000;

  // Each periodic sweep below is wrapped in its own re-entrancy guard so a run
  // that outlasts its interval (slow DB, many tenants) makes the next tick skip
  // instead of stacking overlapping sweeps. Guards are per-sweep, so the timers
  // never block each other — only repeated ticks of the same sweep coalesce.
  const runJobsSweep = createGuardedRunner("SyncScheduler:jobs", async () => {
    console.log("[SyncScheduler] Starting ServiceTitan jobs sync for all tenants");
    const tenants = await db.select().from(tenantsTable).where(eq(tenantsTable.isActive, true));
    for (const tenant of tenants) {
      await syncServiceTitanJobs(tenant.id);
    }
  });
  const jobsTimer = setInterval(() => {
    void runJobsSweep();
  }, jobsSyncInterval);

  const runCampaignSweep = createGuardedRunner("SyncScheduler:campaigns", async () => {
    console.log("[SyncScheduler] Starting Google Ads campaign sync for all tenants");
    const tenants = await db.select().from(tenantsTable).where(eq(tenantsTable.isActive, true));
    for (const tenant of tenants) {
      await syncGoogleAdsCampaigns(tenant.id);
    }
  });
  const campaignTimer = setInterval(() => {
    void runCampaignSweep();
  }, campaignSyncInterval);

  // Meta sync runs nightly at 1 AM Eastern (configurable via META_SYNC_HOUR_ET).
  // Per-tenant 10-second sleep keeps us well under Meta's per-app rate limits
  // even with hundreds of tenants. Scales linearly: 100 tenants = ~17 minutes.
  const metaSyncHourEt = Number(process.env.META_SYNC_HOUR_ET || "1");
  const metaPerTenantSleepMs = Number(process.env.META_PER_TENANT_SLEEP_MS || "10000");
  let lastMetaSyncDateKey = "";
  const runMetaSweep = createGuardedRunner("SyncScheduler:meta", async () => {
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
  });
  const metaTimer = setInterval(() => {
    void runMetaSweep();
  }, 5 * 60 * 1000); // check every 5 minutes whether the trigger hour has arrived

  const invoiceSyncInterval = 15 * 60 * 1000;
  const runInvoiceSweep = createGuardedRunner("SyncScheduler:invoices", async () => {
    console.log("[SyncScheduler] Starting ServiceTitan invoice + estimates sync for all tenants");
    const tenants = await db.select().from(tenantsTable).where(eq(tenantsTable.isActive, true));
    for (const tenant of tenants) {
      await syncServiceTitanInvoices(tenant.id);
      await syncServiceTitanEstimates(tenant.id);
    }
  });
  const invoiceTimer = setInterval(() => {
    void runInvoiceSweep();
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
  // Staleness keys off INACTIVITY (`COALESCE(progress_updated_at, started_at)`),
  // not absolute `started_at` age, so a long-but-healthy backfill is protected
  // by its own progress stamps and the old multi-hour buffer is unnecessary.
  // The periodic sweep therefore uses the SAME inactivity default as the
  // startup reaper (`DEFAULT_INACTIVITY_STALE_MINUTES`), recovering a silently
  // dead run within roughly one sweep instead of hours. Both interval and
  // threshold stay env-overridable so an operator who sees false reaps on
  // unusually slow chunks can raise the window.
  const orphanReaperIntervalMs = Number(process.env.ORPHAN_REAPER_INTERVAL_MS || String(30 * 60 * 1000));
  const orphanReaperStaleMinutes = Number(process.env.ORPHAN_REAPER_STALE_MINUTES || String(DEFAULT_INACTIVITY_STALE_MINUTES));
  const runOrphanReaperSweep = createGuardedRunner("SyncScheduler:orphan-reaper", async () => {
    try {
      const { reapOrphanedSyncLogs } = await import("./orphan-sync-reaper");
      const reaped = await reapOrphanedSyncLogs(orphanReaperStaleMinutes, "periodic reaper sweep");
      if (reaped > 0) {
        console.log(`[SyncScheduler] Periodic orphan reaper flipped ${reaped} stuck sync_log row(s) to error`);
      }
    } catch (err) {
      console.error("[SyncScheduler] Periodic orphan reaper failed:", err);
    }
  });
  const orphanReaperTimer = setInterval(() => {
    void runOrphanReaperSweep();
  }, orphanReaperIntervalMs);

  const callRailSyncIntervalMs = Number(process.env.CALLRAIL_SYNC_INTERVAL_MS || String(60 * 60 * 1000));
  const callRailSyncWindowDays = Math.max(1, Math.min(
    Number(process.env.CALLRAIL_SYNC_WINDOW_DAYS || String(DEFAULT_CALLRAIL_SYNC_DAYS)),
    90,
  ));
  const runCallRailSweep = createGuardedRunner("SyncScheduler:callrail", async () => {
    console.log(`[SyncScheduler] Starting CallRail sync for all configured tenants (${callRailSyncWindowDays}d window)`);
    const tenants = await db.select().from(tenantsTable).where(eq(tenantsTable.isActive, true));
    for (const tenant of tenants) {
      const config = getTenantConfig(tenant);
      if (!config?.callRailApiKey || !config.callRailAccountId) continue;
      await syncCallRailAttribution(tenant.id, {
        days: callRailSyncWindowDays,
        syncType: "calls",
      });
    }
  });
  const callRailTimer = setInterval(() => {
    void runCallRailSweep();
  }, callRailSyncIntervalMs);

  syncTimers = [jobsTimer, campaignTimer, metaTimer, invoiceTimer, reviewTimer, orphanReaperTimer, callRailTimer];
  console.log(`[SyncScheduler] Started: ST jobs 15min, Google Ads 60min, Meta nightly @${metaSyncHourEt}:00 ET, invoices+estimates 15min, Podium PAUSED, CallRail ${Math.round(callRailSyncIntervalMs / 60000)}min (${callRailSyncWindowDays}d attribution window), orphan reaper ${Math.round(orphanReaperIntervalMs / 60000)}min (stale > ${orphanReaperStaleMinutes}min)`);
}

export function stopSyncScheduler() {
  for (const timer of syncTimers) {
    clearInterval(timer);
  }
  syncTimers = [];
}
