import { Router, type IRouter } from "express";
import { db, integrationSyncLogsTable, tenantsTable, jobsTable } from "@workspace/db";
import { eq, desc, and, notInArray, inArray, isNotNull, isNull, count, sql } from "drizzle-orm";
import { requireRole } from "../middleware/auth";
import { syncGoogleAdsCampaigns, syncMetaCampaigns, backfillGoogleAdsCampaigns, backfillServiceTitanJobs } from "../services/sync-scheduler";
import { decryptConfig } from "../lib/encryption";

const router: IRouter = Router();

router.post("/integrations/sync/:integration", requireRole("super_admin", "agency_user"), async (req, res) => {
  const integration = String(req.params.integration);
  const { tenantId } = req.body as { tenantId?: number };

  if (!tenantId) {
    res.status(400).json({ success: false, error: "tenantId is required" });
    return;
  }

  let result: { synced: number; error?: string };

  const unsupportedIntegrations = ["podium", "callrail", "ghl"];
  if (unsupportedIntegrations.includes(integration)) {
    res.json({ success: false, synced: 0, error: `${integration} integration is currently paused` });
    return;
  }

  if (integration === "service_titan") {
    const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId));
    if (tenant?.stSyncPaused) {
      res.json({ success: false, synced: 0, error: "service_titan sync is paused for this tenant" });
      return;
    }
  }

  switch (integration) {
    case "google_ads":
      result = await syncGoogleAdsCampaigns(tenantId);
      break;
    case "meta":
      result = await syncMetaCampaigns(tenantId);
      break;
    case "service_titan":
      res.status(400).json({ success: false, error: "service_titan manual sync is not yet supported" });
      return;
    default:
      res.status(400).json({ success: false, error: `Unknown integration: ${integration}` });
      return;
  }

  if (result.error) {
    res.json({ success: false, synced: 0, error: result.error });
  } else {
    res.json({ success: true, synced: result.synced });
  }
});

/**
 * One-shot historical Google Ads backfill. Mirrors the Meta backfill contract:
 * `days` must be > 30 and ≤ 730. Writes a sync_type='backfill' log row that
 * the Settings panel polls for progress via `/api/integrations/sync-status`.
 */
router.post("/integrations/google_ads/backfill", requireRole("super_admin", "agency_user"), async (req, res) => {
  const tenantId = Number(req.query.tenantId ?? req.body?.tenantId);
  const daysRaw = req.query.days ?? req.body?.days ?? 365;
  const days = Number(daysRaw);

  if (!tenantId || isNaN(tenantId)) {
    res.status(400).json({ error: "tenantId required" });
    return;
  }
  if (!Number.isFinite(days) || days <= 30) {
    res.status(400).json({ error: "days must be a number > 30 (the hourly sync already covers the last 90 days)" });
    return;
  }
  if (days > 730) {
    res.status(400).json({ error: "days cannot exceed 730 (Google Ads reporting retention is ~24 months)" });
    return;
  }

  const result = await backfillGoogleAdsCampaigns(tenantId, days);
  if (result.error) {
    const status = /not found/i.test(result.error) ? 404
      : /not configured/i.test(result.error) ? 400
      : /already running/i.test(result.error) ? 409
      : 502;
    res.status(status).json({ success: false, ...result });
    return;
  }
  res.json({ success: true, ...result });
});

/**
 * One-shot historical ServiceTitan jobs backfill. Mirrors the Meta backfill
 * contract: `days` must be > 30 and ≤ 1095. Walks the trailing window in
 * 90-day chunks using the ST `modifiedOnOrAfter`/`modifiedBefore` filters so
 * each chunk fits inside the per-call page cap inside `fetchCompletedJobs`.
 */
router.post("/integrations/service_titan/backfill", requireRole("super_admin", "agency_user"), async (req, res) => {
  const tenantId = Number(req.query.tenantId ?? req.body?.tenantId);
  const daysRaw = req.query.days ?? req.body?.days ?? 365;
  const days = Number(daysRaw);

  if (!tenantId || isNaN(tenantId)) {
    res.status(400).json({ error: "tenantId required" });
    return;
  }
  if (!Number.isFinite(days) || days <= 30) {
    res.status(400).json({ error: "days must be a number > 30 (the 15-minute scheduler already covers recent jobs)" });
    return;
  }
  if (days > 1095) {
    res.status(400).json({ error: "days cannot exceed 1095 (ST backfill is capped at ~3 years)" });
    return;
  }

  const result = await backfillServiceTitanJobs(tenantId, days);
  if (result.error) {
    const status = /not found/i.test(result.error) ? 404
      : /not configured|paused/i.test(result.error) ? 400
      : /already running/i.test(result.error) ? 409
      : 502;
    res.status(status).json({ success: false, ...result });
    return;
  }
  res.json({ success: true, ...result });
});

router.get("/integrations/sync-status", requireRole("super_admin", "agency_user"), async (req, res) => {
  const tenantId = req.query.tenantId ? Number(req.query.tenantId) : null;
  const tenantCond = tenantId ? eq(integrationSyncLogsTable.tenantId, tenantId) : undefined;

  const MAINTENANCE_SYNC_TYPES = ["st_data_purge", "oci_upload", "enhanced_conversions", "capi_upload", "attribution_writeback"];
  const OUTBOUND_SYNC_TYPES = ["oci_upload", "enhanced_conversions", "capi_upload"];

  const tenantCondJobs = tenantId ? eq(jobsTable.tenantId, tenantId) : undefined;

  const [dataSyncLogs, purgeLogs, runningLogs, outboundLogs, pendingCounts] = await Promise.all([
    db.select()
      .from(integrationSyncLogsTable)
      .where(tenantCond
        ? and(tenantCond, notInArray(integrationSyncLogsTable.syncType, MAINTENANCE_SYNC_TYPES))
        : notInArray(integrationSyncLogsTable.syncType, MAINTENANCE_SYNC_TYPES))
      .orderBy(desc(integrationSyncLogsTable.createdAt))
      .limit(60),
    db.select()
      .from(integrationSyncLogsTable)
      .where(tenantCond
        ? and(tenantCond, eq(integrationSyncLogsTable.syncType, "st_data_purge"))
        : eq(integrationSyncLogsTable.syncType, "st_data_purge"))
      .orderBy(desc(integrationSyncLogsTable.createdAt))
      .limit(1),
    db.select()
      .from(integrationSyncLogsTable)
      .where(tenantCond
        ? and(tenantCond, eq(integrationSyncLogsTable.status, "running"), notInArray(integrationSyncLogsTable.syncType, MAINTENANCE_SYNC_TYPES))
        : and(eq(integrationSyncLogsTable.status, "running"), notInArray(integrationSyncLogsTable.syncType, MAINTENANCE_SYNC_TYPES)))
      .orderBy(desc(integrationSyncLogsTable.createdAt))
      .limit(10),
    db.select()
      .from(integrationSyncLogsTable)
      .where(tenantCond
        ? and(tenantCond, inArray(integrationSyncLogsTable.syncType, OUTBOUND_SYNC_TYPES))
        : inArray(integrationSyncLogsTable.syncType, OUTBOUND_SYNC_TYPES))
      .orderBy(desc(integrationSyncLogsTable.createdAt))
      .limit(30),
    db.select({
      ociPending: count(sql`CASE WHEN matched_gclid IS NOT NULL AND oci_uploaded_at IS NULL AND revenue > 0 THEN 1 END`),
      enhancedPending: count(sql`CASE WHEN matched_gclid IS NULL AND revenue > 0 AND enhanced_conversion_uploaded_at IS NULL AND match_level IS NOT NULL THEN 1 END`),
      capiPending: count(sql`CASE WHEN capi_uploaded_at IS NULL AND match_level IS NOT NULL THEN 1 END`),
    })
      .from(jobsTable)
      .where(tenantCondJobs
        ? and(tenantCondJobs, isNotNull(jobsTable.matchLevel))
        : isNotNull(jobsTable.matchLevel)),
  ]);

  const configuredMap: Record<string, boolean> = { service_titan: false, google_ads: false, meta: false };
  const pausedMap: Record<string, boolean> = { service_titan: false, google_ads: false, meta: false };
  const reconnectMap: Record<string, { needs: boolean; reason: string | null }> = {
    service_titan: { needs: false, reason: null },
    google_ads: { needs: false, reason: null },
    meta: { needs: false, reason: null },
  };
  if (tenantId) {
    const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId));
    if (tenant) {
      pausedMap.service_titan = tenant.stSyncPaused === true;
      reconnectMap.meta = {
        needs: tenant.metaNeedsReconnect === true,
        reason: tenant.metaReconnectReason ?? null,
      };
      if (tenant.apiConfig && typeof tenant.apiConfig === "string") {
        try {
          const config = decryptConfig(tenant.apiConfig) as Record<string, string>;
          configuredMap.service_titan = !!(config.serviceTitanClientId && config.serviceTitanClientSecret && config.serviceTitanAppKey);
          configuredMap.google_ads = !!(config.googleAdsApiKey && config.googleAdsCustomerId && config.googleAdsDeveloperToken);
          // "configured" = credentials saved. "needs_reconnect" is reported as a
          // separate, distinct state below — never collapsed into no_credentials.
          configuredMap.meta = !!(config.metaAccessToken && config.metaAdAccountId);
        } catch { /* decryption failed */ }
      }
    }
  }

  type IntegrationState = "running" | "paused" | "healthy" | "error" | "no_credentials" | "needs_reconnect" | "never";

  const integrations = ["service_titan", "google_ads", "meta"] as const;
  const statusByIntegration: Record<string, {
    lastSync: string | null;
    lastStatus: string;
    lastRecords: number;
    errorCount: number;
    latestRunAt: string | null;
    state: IntegrationState;
    needsReconnect: boolean;
    reconnectReason: string | null;
    syncTypes: Record<string, { lastRun: string | null; lastStatus: string; recordsProcessed: number }>;
  }> = {};

  for (const integ of integrations) {
    const integLogs = dataSyncLogs.filter((l) => l.integration === integ);
    const isRunning = runningLogs.some((l) => l.integration === integ);
    const latest = integLogs[0];
    const lastSuccessful = integLogs.find((l) => l.status === "completed");

    const syncTypes: Record<string, { lastRun: string | null; lastStatus: string; recordsProcessed: number }> = {};
    const typeSet = new Set(integLogs.map((l) => l.syncType));
    for (const st of typeSet) {
      const typeLogs = integLogs.filter((l) => l.syncType === st);
      const latestOfType = typeLogs[0];
      syncTypes[st] = {
        lastRun: latestOfType?.completedAt?.toISOString() || null,
        lastStatus: latestOfType?.status || "never",
        recordsProcessed: latestOfType?.recordsProcessed || 0,
      };
    }

    let state: IntegrationState = "never";
    if (isRunning) {
      state = "running";
    } else if (pausedMap[integ]) {
      state = "paused";
    } else if (tenantId && !configuredMap[integ]) {
      state = "no_credentials";
    } else if (tenantId && reconnectMap[integ]?.needs) {
      // Distinct from no_credentials: credentials exist but the upstream
      // OAuth/API token has expired or been revoked, so we surface a
      // reconnect-required signal that the UI can show as its own badge.
      state = "needs_reconnect";
    } else if (latest?.status === "error") {
      state = "error";
    } else if (latest?.status === "completed") {
      state = "healthy";
    }

    statusByIntegration[integ] = {
      lastSync: lastSuccessful?.completedAt?.toISOString() || null,
      lastStatus: latest?.status || "never",
      lastRecords: latest?.recordsProcessed || 0,
      errorCount: integLogs.filter((l) => l.status === "error").length,
      latestRunAt: latest?.completedAt?.toISOString() || null,
      state,
      needsReconnect: reconnectMap[integ]?.needs ?? false,
      reconnectReason: reconnectMap[integ]?.reason ?? null,
      syncTypes,
    };
  }

  const lastPurge = purgeLogs[0];

  const outboundPushTypes = ["oci_upload", "enhanced_conversions", "capi_upload"] as const;
  const outboundPushStatus: Record<string, {
    lastSuccess: string | null;
    lastStatus: string;
    recordsPushed: number;
    lastError: string | null;
    pendingCount: number;
  }> = {};

  const pending = pendingCounts[0] || { ociPending: 0, enhancedPending: 0, capiPending: 0 };

  for (const pushType of outboundPushTypes) {
    const typeLogs = outboundLogs.filter((l) => l.syncType === pushType);
    const lastSuccessful = typeLogs.find((l) => l.status === "completed" || l.status === "partial");
    const lastWithError = typeLogs.find((l) => l.status === "error" || l.status === "partial");

    outboundPushStatus[pushType] = {
      lastSuccess: lastSuccessful?.completedAt?.toISOString() || null,
      lastStatus: typeLogs[0]?.status || "never",
      recordsPushed: lastSuccessful?.recordsProcessed || 0,
      lastError: lastWithError?.errorMessage || null,
      pendingCount: pushType === "oci_upload"
        ? Number(pending.ociPending)
        : pushType === "enhanced_conversions"
          ? Number(pending.enhancedPending)
          : Number(pending.capiPending),
    };
  }

  const allLogs = [...dataSyncLogs, ...outboundLogs]
    .sort((a, b) => (b.createdAt?.getTime() || 0) - (a.createdAt?.getTime() || 0))
    .slice(0, 20);

  // Surface the latest historical-backfill log row per integration. The
  // generic `syncTypes` aggregation only carries lastRun/lastStatus/records,
  // but the backfill writer also stashes a human-readable chunk-progress
  // string in `errorMessage` while running. The Settings panel needs that
  // string + startedAt to show in-flight progress to operators. Any
  // integration that writes a `backfill` sync_type row gets the same
  // treatment — we don't hardcode to Meta.
  const backfillStatus: Record<string, {
    status: string;
    recordsProcessed: number;
    progress: string | null;
    startedAt: string | null;
    completedAt: string | null;
  }> = {};
  for (const integ of integrations) {
    const log = dataSyncLogs.find(
      (l) => l.integration === integ && l.syncType === "backfill",
    );
    if (log) {
      backfillStatus[integ] = {
        status: log.status,
        recordsProcessed: log.recordsProcessed,
        progress: log.errorMessage,
        startedAt: log.startedAt?.toISOString() ?? null,
        completedAt: log.completedAt?.toISOString() ?? null,
      };
    }
  }

  res.json({
    statusByIntegration,
    recentLogs: allLogs,
    outboundPushStatus,
    purgeStatus: lastPurge ? {
      lastRun: lastPurge.completedAt?.toISOString() || null,
      status: lastPurge.status,
      recordsProcessed: lastPurge.recordsProcessed,
    } : null,
    backfillStatus,
    // Back-compat alias for older clients still reading metaBackfillStatus.
    // Safe to remove once all consumers migrate to backfillStatus.meta.
    metaBackfillStatus: backfillStatus.meta ?? null,
  });
});

router.get("/integrations/tenant-config/:tenantId", requireRole("super_admin", "agency_user"), async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId));
  if (!tenant) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }

  const configuredIntegrations: Record<string, boolean> = {
    service_titan: false,
    google_ads: false,
    meta: false,
    callrail: false,
  };

  if (tenant.apiConfig && typeof tenant.apiConfig === "string") {
    try {
      const config = decryptConfig(tenant.apiConfig) as Record<string, string>;
      configuredIntegrations.service_titan = !!(config.serviceTitanClientId && config.serviceTitanClientSecret);
      configuredIntegrations.google_ads = !!(config.googleAdsApiKey && config.googleAdsCustomerId && config.googleAdsDeveloperToken);
      configuredIntegrations.meta = !!(config.metaAccessToken && config.metaAdAccountId);
      configuredIntegrations.callrail = !!config.callRailApiKey;
    } catch {
      // decryption failed
    }
  }

  res.json({ tenantId, configuredIntegrations });
});

export default router;
