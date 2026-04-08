import { Router, type IRouter } from "express";
import { db, integrationSyncLogsTable, tenantsTable } from "@workspace/db";
import { eq, desc, and } from "drizzle-orm";
import { requireRole } from "../middleware/auth";
import { syncGoogleAdsCampaigns, syncMetaCampaigns } from "../services/sync-scheduler";
import { decryptConfig } from "../lib/encryption";

const router: IRouter = Router();

router.post("/integrations/sync/:integration", requireRole("super_admin", "agency_user"), async (req, res) => {
  const { integration } = req.params;
  const { tenantId } = req.body as { tenantId?: number };

  if (!tenantId) {
    res.status(400).json({ success: false, error: "tenantId is required" });
    return;
  }

  let result: { synced: number; error?: string };

  const pausedIntegrations = ["service_titan", "podium", "callrail", "ghl"];
  if (pausedIntegrations.includes(integration)) {
    res.json({ success: false, synced: 0, error: `${integration} integration is currently paused` });
    return;
  }

  switch (integration) {
    case "google_ads":
      result = await syncGoogleAdsCampaigns(tenantId);
      break;
    case "meta":
      result = await syncMetaCampaigns(tenantId);
      break;
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

router.get("/integrations/sync-status", requireRole("super_admin", "agency_user"), async (req, res) => {
  const tenantId = req.query.tenantId ? Number(req.query.tenantId) : null;
  const conditions = tenantId ? eq(integrationSyncLogsTable.tenantId, tenantId) : undefined;

  const recentLogs = await db.select()
    .from(integrationSyncLogsTable)
    .where(conditions)
    .orderBy(desc(integrationSyncLogsTable.createdAt))
    .limit(100);

  const PURGE_TYPES = new Set(["st_data_purge"]);
  const MAINTENANCE_TYPES = new Set(["st_data_purge", "oci_upload", "enhanced_conversions", "capi_upload", "attribution_writeback"]);

  const syncLogs = recentLogs.filter((l) => !PURGE_TYPES.has(l.syncType));
  const purgeLogs = recentLogs.filter((l) => PURGE_TYPES.has(l.syncType));

  const integrations = ["service_titan", "google_ads", "meta"];
  const statusByIntegration: Record<string, { lastSync: string | null; lastStatus: string; lastRecords: number; errorCount: number; latestRunAt: string | null; syncTypes: Record<string, { lastRun: string | null; lastStatus: string; recordsProcessed: number }> }> = {};

  for (const integ of integrations) {
    const integLogs = syncLogs.filter((l) => l.integration === integ);
    const latest = integLogs.find((l) => !MAINTENANCE_TYPES.has(l.syncType));
    const lastSuccessful = integLogs.find((l) => l.status === "completed" && !MAINTENANCE_TYPES.has(l.syncType));

    const syncTypes: Record<string, { lastRun: string | null; lastStatus: string; recordsProcessed: number }> = {};
    const typeSet = new Set(integLogs.map((l) => l.syncType));
    for (const st of typeSet) {
      if (MAINTENANCE_TYPES.has(st)) continue;
      const typeLogs = integLogs.filter((l) => l.syncType === st);
      const latestOfType = typeLogs[0];
      syncTypes[st] = {
        lastRun: latestOfType?.completedAt?.toISOString() || null,
        lastStatus: latestOfType?.status || "never",
        recordsProcessed: latestOfType?.recordsProcessed || 0,
      };
    }

    statusByIntegration[integ] = {
      lastSync: lastSuccessful?.completedAt?.toISOString() || null,
      lastStatus: latest?.status || "never",
      lastRecords: latest?.recordsProcessed || 0,
      errorCount: integLogs.filter((l) => l.status === "error" && !MAINTENANCE_TYPES.has(l.syncType)).length,
      latestRunAt: latest?.completedAt?.toISOString() || null,
      syncTypes,
    };
  }

  const mainLogs = recentLogs
    .filter((l) => !PURGE_TYPES.has(l.syncType))
    .slice(0, 20);

  const lastPurge = purgeLogs[0];

  res.json({
    statusByIntegration,
    recentLogs: mainLogs,
    purgeStatus: lastPurge ? {
      lastRun: lastPurge.completedAt?.toISOString() || null,
      status: lastPurge.status,
      recordsProcessed: lastPurge.recordsProcessed,
    } : null,
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
