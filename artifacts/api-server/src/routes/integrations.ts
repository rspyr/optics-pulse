import { Router, type IRouter } from "express";
import { db, integrationSyncLogsTable, tenantsTable, jobsTable } from "@workspace/db";
import { eq, desc, and, notInArray, inArray, isNotNull, isNull, count, sql } from "drizzle-orm";
import { requireRole } from "../middleware/auth";
import { syncGoogleAdsCampaigns, syncMetaCampaigns, backfillGoogleAdsCampaigns, backfillServiceTitanJobs, syncServiceTitanEstimates, syncServiceTitanInvoices } from "../services/sync-scheduler";
import { decryptConfig } from "../lib/encryption";
import { parseBackfillProgress, classifyBackfillError, type BackfillProgressDetail, type BackfillErrorDetail } from "../services/backfill-status-format";

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

/**
 * Recompute sold-estimate and invoice revenue with the corrected rebate logic.
 * Runs a full re-sync (ignoring the incremental watermark) so historical rows
 * that added back ALL negative line items are rewritten to add back only true
 * rebate line items (ETO, ODEE, ...). Genuine discounts stay subtracted.
 */
router.post("/integrations/service_titan/recompute-revenue", requireRole("super_admin", "agency_user"), async (req, res) => {
  const tenantId = Number(req.query.tenantId ?? req.body?.tenantId);

  if (!tenantId || isNaN(tenantId)) {
    res.status(400).json({ error: "tenantId required" });
    return;
  }

  const invoices = await syncServiceTitanInvoices(tenantId, { fullResync: true });

  // If the operator cancelled during the invoices phase, don't start the
  // estimates phase — the whole recompute is being aborted. Rows already
  // reprocessed are kept (no rollback).
  if (invoices.error === "cancelled") {
    res.json({ success: true, cancelled: true, invoices, estimates: { synced: 0, error: "skipped" } });
    return;
  }

  const estimates = await syncServiceTitanEstimates(tenantId, { fullResync: true });

  if (estimates.error === "cancelled") {
    res.json({ success: true, cancelled: true, invoices, estimates });
    return;
  }

  const firstError = invoices.error || estimates.error;
  if (firstError) {
    const status = /not found/i.test(firstError) ? 404
      : /not configured|paused/i.test(firstError) ? 400
      : 502;
    res.status(status).json({ success: false, invoices, estimates });
    return;
  }
  res.json({ success: true, invoices, estimates });
});

// Flip the cooperative cancel flag on a running backfill sync log. The
// long-running backfill polls this flag at chunk boundaries + after every
// batch and unwinds gracefully, completing the row with status='cancelled'
// and whatever rows have already landed (no rollback — partial data is
// useful). 404 if the log doesn't exist; 409 if the run already finished.
router.post("/integrations/sync-logs/:id/cancel", requireRole("super_admin", "agency_user"), async (req, res) => {
  const logId = Number(req.params.id);
  const force = req.query.force === "true" || req.body?.force === true;
  if (!Number.isFinite(logId) || logId <= 0) {
    res.status(400).json({ error: "Invalid sync log id" });
    return;
  }
  const [log] = await db.select()
    .from(integrationSyncLogsTable)
    .where(eq(integrationSyncLogsTable.id, logId))
    .limit(1);
  if (!log) {
    res.status(404).json({ error: "Sync log not found" });
    return;
  }
  if (log.status !== "running") {
    res.status(409).json({ error: `Sync log is not running (status=${log.status})` });
    return;
  }

  // Force-cancel escape hatch: hard-flips the row to `cancelled` directly,
  // bypassing the cooperative cancel-flag handshake. Use when the worker is
  // dead/unresponsive (server restarted mid-run, or the cancel flag was
  // already set and nothing happened). The advisory lock auto-releases on
  // next DB connection turnover.
  //
  // We deliberately do NOT auto-trigger force based on `startedAt` age —
  // `startedAt` is run-start time, not cancel-request time, so any long
  // legitimately-running backfill would be force-killed on the operator's
  // first Cancel click. The UI gates this behind a separate "Force cancel"
  // button that only appears after the cooperative cancel has had time to
  // unwind. The orphan reaper at server startup handles the restart case.
  if (force) {
    await db.update(integrationSyncLogsTable)
      .set({
        status: "cancelled",
        completedAt: new Date(),
        errorMessage: "Force-cancelled by operator",
        errorCode: null,
        progressCurrentChunk: null,
        progressTotalChunks: null,
        progressWindowStart: null,
        progressWindowEnd: null,
      })
      .where(eq(integrationSyncLogsTable.id, logId));
    res.json({ success: true, logId, forced: true, message: "Run hard-cancelled. Any worker still alive will exit on its next cancel check." });
    return;
  }

  await db.update(integrationSyncLogsTable)
    .set({ cancelRequested: true })
    .where(eq(integrationSyncLogsTable.id, logId));
  res.json({ success: true, logId, forced: false, message: "Cancel requested — run will stop after the current batch" });
});

router.get("/integrations/sync-status", requireRole("super_admin", "agency_user"), async (req, res) => {
  const tenantId = req.query.tenantId ? Number(req.query.tenantId) : null;
  const tenantCond = tenantId ? eq(integrationSyncLogsTable.tenantId, tenantId) : undefined;

  const MAINTENANCE_SYNC_TYPES = ["st_data_purge", "oci_upload", "enhanced_conversions", "capi_upload", "attribution_writeback"];
  const OUTBOUND_SYNC_TYPES = ["oci_upload", "enhanced_conversions", "capi_upload"];

  const tenantCondJobs = tenantId ? eq(jobsTable.tenantId, tenantId) : undefined;

  const [dataSyncLogs, purgeLogs, runningLogs, outboundLogs, pendingCounts, cumulativeTotals] = await Promise.all([
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
    // Cumulative records_synced per (integration, sync_type) across ALL
    // completed runs in history. The dashboard previously showed only the
    // latest run's count — which was misleading for incremental syncs that
    // poll every 15min and almost always return 0 in any single window
    // (e.g. ServiceTitan invoices showed "0 rec" even though thousands had
    // been synced over time). We sum over the entire log table so the
    // value reflects the true volume pulled in, not a momentary snapshot.
    db.select({
      integration: integrationSyncLogsTable.integration,
      syncType: integrationSyncLogsTable.syncType,
      totalRecords: sql<number>`COALESCE(SUM(${integrationSyncLogsTable.recordsProcessed}), 0)::int`,
    })
      .from(integrationSyncLogsTable)
      .where(tenantCond
        ? and(tenantCond, eq(integrationSyncLogsTable.status, "completed"), notInArray(integrationSyncLogsTable.syncType, MAINTENANCE_SYNC_TYPES))
        : and(eq(integrationSyncLogsTable.status, "completed"), notInArray(integrationSyncLogsTable.syncType, MAINTENANCE_SYNC_TYPES)))
      .groupBy(integrationSyncLogsTable.integration, integrationSyncLogsTable.syncType),
  ]);

  // Index cumulative totals for fast lookup in the per-integration loop.
  const cumulativeByKey = new Map<string, number>();
  for (const row of cumulativeTotals as Array<{ integration: string; syncType: string; totalRecords: number | string }>) {
    cumulativeByKey.set(`${row.integration}:${row.syncType}`, Number(row.totalRecords) || 0);
  }

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
    latestErrorCode: string | null;
    syncTypes: Record<string, { lastRun: string | null; lastStatus: string; recordsProcessed: number; totalRecordsProcessed: number; runningLogId: number | null; cancelRequested: boolean; totalRecords: number | null }>;
  }> = {};

  for (const integ of integrations) {
    const integLogs = dataSyncLogs.filter((l) => l.integration === integ);
    const isRunning = runningLogs.some((l) => l.integration === integ);
    const latest = integLogs[0];
    const lastSuccessful = integLogs.find((l) => l.status === "completed");

    const syncTypes: Record<string, { lastRun: string | null; lastStatus: string; recordsProcessed: number; totalRecordsProcessed: number; runningLogId: number | null; cancelRequested: boolean; totalRecords: number | null }> = {};
    // Union of sync types: from the recent log window (latest run/status info)
    // AND from the cumulative aggregation (which covers full history, so we
    // still show sync types whose last run is older than the 60-row window).
    const typeSet = new Set<string>(integLogs.map((l) => l.syncType));
    for (const row of cumulativeTotals as Array<{ integration: string; syncType: string }>) {
      if (row.integration === integ) typeSet.add(row.syncType);
    }
    for (const st of typeSet) {
      const typeLogs = integLogs.filter((l) => l.syncType === st);
      const latestOfType = typeLogs[0];
      syncTypes[st] = {
        lastRun: latestOfType?.completedAt?.toISOString() || null,
        lastStatus: latestOfType?.status || "never",
        recordsProcessed: latestOfType?.recordsProcessed || 0,
        totalRecordsProcessed: cumulativeByKey.get(`${integ}:${st}`) || 0,
        // Surface the in-flight log id + cancel flag so the recompute card
        // can POST to `/sync-logs/:id/cancel` and swap to a "Cancelling…"
        // state. Only meaningful while the latest run is `running`.
        runningLogId: latestOfType?.status === "running" ? latestOfType.id : null,
        cancelRequested: latestOfType?.cancelRequested === true,
        // Estimated total record count for the latest run (set during a full
        // re-sync / revenue recompute). Lets the UI render a percent bar.
        totalRecords: latestOfType?.progressTotalRecords ?? null,
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
      latestErrorCode: latest?.status === "error" ? (latest.errorCode ?? null) : null,
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
    /** Sync log row id — used by the UI to POST to `/sync-logs/:id/cancel`. */
    syncLogId: number;
    /** True after a user clicked Cancel and before the run has flipped to
     *  the terminal `cancelled` status. Lets the UI swap the button to a
     *  "Cancelling…" pending state. */
    cancelRequested: boolean;
    progress: string | null;
    /** Structured chunk progress when the writer most recently stashed a
     *  `chunk N/M: …` string. Null when the message can't be parsed (e.g.
     *  the run finished or only an error message is present). */
    progressDetail: BackfillProgressDetail | null;
    /** Friendly classification of the most recent error message. Set when
     *  the row is in `error` status OR when the writer stashed a
     *  `partial: …` mid-run failure but the outer status hasn't flipped
     *  yet. Null on healthy / completed runs. */
    errorDetail: BackfillErrorDetail | null;
    /** When non-null, this backfill was auto-enqueued by another sync run
     *  (e.g. the nightly catch-up clamp in Task #564). The UI uses this to
     *  badge the row so operators can explain why a 6-month backfill just
     *  appeared without an operator clicking Run. */
    triggeredBySyncLogId: number | null;
    /** Materialized parent-run summary when `triggeredBySyncLogId` is set.
     *  The UI uses this as a popover fallback when the parent row isn't in
     *  the currently-loaded Recent Activity slice, so operators can still
     *  see what kicked the backfill off without paging through history. */
    triggeredByParent: {
      id: number;
      integration: string;
      syncType: string;
      status: string;
      startedAt: string | null;
      completedAt: string | null;
    } | null;
    startedAt: string | null;
    completedAt: string | null;
  }> = {};
  for (const integ of integrations) {
    const log = dataSyncLogs.find(
      (l) => l.integration === integ && l.syncType === "backfill",
    );
    if (log) {
      // Prefer structured columns (Task #395) populated directly by the
      // backfill writers. Fall back to the regex parser only for legacy
      // rows that pre-date the schema change and still carry chunk /
      // partial state inside `errorMessage`.
      let progressDetail: BackfillProgressDetail | null = null;
      if (log.progressCurrentChunk != null && log.progressTotalChunks != null) {
        const current = log.progressCurrentChunk;
        const total = log.progressTotalChunks;
        const percent = total > 0
          ? Math.max(0, Math.min(100, Math.round(((current - 1) / total) * 100)))
          : null;
        progressDetail = {
          raw: `chunk ${current}/${total}: ${log.progressWindowStart ?? ""} → ${log.progressWindowEnd ?? ""}`,
          kind: "chunk",
          currentChunk: current,
          totalChunks: total,
          windowStart: log.progressWindowStart ?? null,
          windowEnd: log.progressWindowEnd ?? null,
          percent,
          partialReason: null,
        };
      } else {
        // Legacy fallback for old rows.
        const parsed = parseBackfillProgress(log.errorMessage);
        progressDetail = parsed && parsed.kind === "chunk" ? parsed : null;
      }

      // Build a friendly error from structured columns when present, else
      // classify the raw message (legacy rows).
      let errorDetail: BackfillErrorDetail | null = null;
      const isPartial = log.partial === true;
      const looksLikeError = log.status === "error" || isPartial;
      if (looksLikeError) {
        if (log.errorCode) {
          // Structured path: the writer already classified this. Reuse the
          // classifier on the raw message to fetch the matching friendly
          // copy + suggested action so we don't duplicate the rule table
          // here. If classification disagrees with the stored code (e.g.
          // a future writer sets a code we don't have a rule for) we fall
          // back to a minimal detail keyed off the stored code.
          const classified = classifyBackfillError(log.errorMessage);
          if (classified && classified.code === log.errorCode) {
            errorDetail = { ...classified, partial: isPartial,
              message: isPartial && !classified.partial
                ? `Partial backfill: ${classified.message}`
                : classified.message };
          } else {
            errorDetail = {
              raw: log.errorMessage ?? "",
              code: log.errorCode as BackfillErrorDetail["code"],
              message: isPartial
                ? "Partial backfill: the upstream API returned an error."
                : "The upstream API returned an error.",
              suggestedAction: "Check the recent sync activity for the raw error and retry.",
              partial: isPartial,
            };
          }
        } else {
          errorDetail = classifyBackfillError(log.errorMessage);
          if (errorDetail && isPartial && !errorDetail.partial) {
            errorDetail = { ...errorDetail, partial: true, message: `Partial backfill: ${errorDetail.message}` };
          }
        }
      }

      // `progress` (string) is preserved for back-compat with older clients.
      // Synthesize it from structured columns when available so the wire
      // shape doesn't change for callers that still read the string.
      const progressString = progressDetail?.kind === "chunk"
        ? progressDetail.raw
        : log.errorMessage;

      // When the row was auto-enqueued, materialize a small summary of the
      // parent run so the UI can fall back to a popover when the parent
      // isn't in the currently-loaded Recent Activity slice. Prefer the
      // in-memory `dataSyncLogs` snapshot (already fetched, no extra DB
      // round-trip); only hit the DB when the parent is older than the
      // 60-row window we just loaded.
      let triggeredByParent: {
        id: number;
        integration: string;
        syncType: string;
        status: string;
        startedAt: string | null;
        completedAt: string | null;
      } | null = null;
      if (log.triggeredBySyncLogId != null) {
        const parentId = log.triggeredBySyncLogId;
        let parent = dataSyncLogs.find((l) => l.id === parentId);
        if (!parent) {
          const [fetched] = await db.select()
            .from(integrationSyncLogsTable)
            .where(eq(integrationSyncLogsTable.id, parentId))
            .limit(1);
          parent = fetched;
        }
        if (parent) {
          triggeredByParent = {
            id: parent.id,
            integration: parent.integration,
            syncType: parent.syncType,
            status: parent.status,
            startedAt: parent.startedAt?.toISOString() ?? null,
            completedAt: parent.completedAt?.toISOString() ?? null,
          };
        }
      }

      backfillStatus[integ] = {
        status: log.status,
        recordsProcessed: log.recordsProcessed,
        syncLogId: log.id,
        cancelRequested: log.cancelRequested === true,
        progress: progressString,
        progressDetail,
        errorDetail,
        triggeredBySyncLogId: log.triggeredBySyncLogId ?? null,
        triggeredByParent,
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
