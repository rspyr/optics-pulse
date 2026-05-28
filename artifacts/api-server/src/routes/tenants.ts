import { Router, type IRouter } from "express";
import { db, tenantsTable, usersTable, leadSourceAliasesTable, callrailWebhookStatusTable } from "@workspace/db";
import { eq, sql, and } from "drizzle-orm";
import { CreateTenantBody, GetTenantParams, UpdateTenantBody } from "@workspace/api-zod";
import { requireRole } from "../middleware/auth";
import { assertResourceTenantAccess } from "../lib/tenant-scope";
import { encryptConfig, decryptConfig } from "../lib/encryption";
import { DEFAULT_SOURCE_ALIASES } from "../services/source-normalizer";
import { DEFAULT_REBATE_LABELS } from "../services/integrations/service-titan";

const router: IRouter = Router();

const SECRET_FIELDS = new Set([
  "googleAdsApiKey",
  "googleAdsDeveloperToken",
  "googleAdsRefreshToken",
  "googleAdsClientId",
  "googleAdsClientSecret",
  "callRailApiKey",
  "callRailSigningKey",
  "serviceTitanClientId",
  "serviceTitanClientSecret",
  "serviceTitanAppKey",
  "metaAccessToken",
  "metaAppSecret", // legacy: pre-shared-app data; still masked on read for safety
  "ghlApiKey",
  "podiumApiToken",
]);

function sanitizeTenant(tenant: typeof tenantsTable.$inferSelect) {
  const result: Record<string, unknown> = { ...tenant };
  if (tenant.apiConfig && typeof tenant.apiConfig === "string") {
    try {
      const decrypted = decryptConfig(tenant.apiConfig);
      const masked: Record<string, unknown> = {};
      const loadable: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(decrypted)) {
        if (SECRET_FIELDS.has(key)) {
          if (typeof val === "string" && val.length > 0) {
            masked[key] = `****${val.slice(-4)}`;
            loadable[key] = `••••${val.slice(-4)}`;
          } else {
            masked[key] = val;
            loadable[key] = val;
          }
        } else {
          masked[key] = val;
          loadable[key] = val;
        }
      }
      result.apiConfig = masked;
      result.loadableConfig = loadable;
      result.hasIntegrationConfig = true;
    } catch {
      result.apiConfig = null;
      result.loadableConfig = {};
      result.hasIntegrationConfig = false;
    }
  } else {
    result.hasIntegrationConfig = false;
    result.loadableConfig = {};
  }
  result.alertConfig = tenant.alertConfig || null;
  const rawCommConfig = (tenant.communicationConfig || {}) as Record<string, unknown>;
  result.communicationConfig = {
    callPlatform: rawCommConfig.callPlatform || "native",
    textPlatform: rawCommConfig.textPlatform || "native",
  };
  const rawLbConfig = (tenant.leaderboardConfig || {}) as Record<string, unknown>;
  result.leaderboardConfig = {
    visible: rawLbConfig.visible !== undefined ? Boolean(rawLbConfig.visible) : false,
    displayMode: rawLbConfig.displayMode === "named" ? "named" : "anonymized",
  };
  const rawRevConfig = (tenant.revenueConfig || {}) as Record<string, unknown>;
  const storedLabels = Array.isArray(rawRevConfig.rebateLabels)
    ? (rawRevConfig.rebateLabels as unknown[]).filter(
        (l): l is string => typeof l === "string" && l.trim().length > 0,
      )
    : null;
  result.revenueConfig = {
    // Surface the seeded defaults when the tenant hasn't customized its list so
    // the admin UI always shows the rebate programs currently in effect.
    rebateLabels: storedLabels && storedLabels.length > 0 ? storedLabels : [...DEFAULT_REBATE_LABELS],
    usingDefaults: !(storedLabels && storedLabels.length > 0),
  };
  return result;
}

router.get("/tenants", async (req, res) => {
  const role = req.session.userRole;
  if (role === "super_admin" || role === "agency_user") {
    const tenants = await db.select().from(tenantsTable);
    res.json(tenants.map(sanitizeTenant));
  } else {
    const [user] = await db.select({ tenantId: usersTable.tenantId }).from(usersTable).where(eq(usersTable.id, req.session.userId!));
    if (!user?.tenantId) {
      res.json([]);
      return;
    }
    const tenants = await db.select().from(tenantsTable).where(eq(tenantsTable.id, user.tenantId));
    res.json(tenants.map(sanitizeTenant));
  }
});

router.post("/tenants", requireRole("super_admin", "agency_user"), async (req, res) => {
  const body = CreateTenantBody.parse(req.body);
  const slugify = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  let baseSlug = slugify(body.name) || "tenant";
  let candidateSlug = baseSlug;
  let suffix = 1;
  while (true) {
    const [existing] = await db.select({ id: tenantsTable.id }).from(tenantsTable).where(eq(tenantsTable.clientSlug, candidateSlug)).limit(1);
    if (!existing) break;
    suffix++;
    candidateSlug = `${baseSlug}-${suffix}`;
  }
  const insertData: Record<string, unknown> = {
    name: body.name,
    clientSlug: candidateSlug,
    serviceTitanId: body.serviceTitanId,
    timezone: body.timezone || "America/New_York",
    isDemo: req.body.isDemo === true ? true : false,
  };
  if (req.body.integrationConfig && typeof req.body.integrationConfig === "object") {
    insertData.apiConfig = encryptConfig(req.body.integrationConfig);
  }
  const [tenant] = await db.insert(tenantsTable).values(insertData as typeof tenantsTable.$inferInsert).returning();

  try {
    for (const group of DEFAULT_SOURCE_ALIASES) {
      for (const alias of group.aliases) {
        await db.insert(leadSourceAliasesTable).values({
          tenantId: tenant.id,
          canonicalName: group.canonicalName,
          alias: alias.toLowerCase(),
        });
      }
    }
    console.log(`[Tenants] Seeded default source aliases for new tenant ${tenant.id}`);
  } catch (err) {
    console.warn(`[Tenants] Failed to seed source aliases for tenant ${tenant.id}:`, err);
  }

  res.status(201).json(sanitizeTenant(tenant));
});

router.get("/tenants/:tenantId", async (req, res) => {
  const { tenantId } = GetTenantParams.parse({ tenantId: req.params.tenantId });
  // Path-resolved resource: super_admin / agency_user may read any
  // tenant, but a tenant-scoped role may only read its own. The
  // resource's "tenantId" is the requested id itself (a tenant row's
  // tenantId is its own id).
  const access = assertResourceTenantAccess(req, res, tenantId);
  if (!access.ok) return;
  const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId));
  if (!tenant) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }
  res.json(sanitizeTenant(tenant));
});

router.patch("/tenants/:tenantId", async (req, res) => {
  const role = req.session.userRole;
  const { tenantId } = GetTenantParams.parse({ tenantId: req.params.tenantId });

  // Only super_admin / agency_user / client_admin may PATCH a tenant.
  // For client_admin the helper enforces same-tenant access; everyone
  // else (e.g. tenant_user, client_user) is rejected here.
  if (role !== "super_admin" && role !== "agency_user" && role !== "client_admin") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const access = assertResourceTenantAccess(req, res, tenantId, {
    deniedMessage: "Cannot modify another tenant",
  });
  if (!access.ok) return;

  const body = UpdateTenantBody.parse(req.body);
  const updateData: Partial<typeof tenantsTable.$inferInsert> & { updatedAt: Date } = { updatedAt: new Date() };
  if (body.name !== undefined) updateData.name = body.name;
  if (body.serviceTitanId !== undefined) updateData.serviceTitanId = body.serviceTitanId;
  if (body.timezone !== undefined) updateData.timezone = body.timezone;
  if (body.isActive !== undefined) updateData.isActive = body.isActive;
  if (req.body.isDemo !== undefined && (role === "super_admin" || role === "agency_user")) {
    updateData.isDemo = req.body.isDemo === true;
  }
  if (body.stSyncPaused !== undefined && (role === "super_admin" || role === "agency_user")) {
    updateData.stSyncPaused = body.stSyncPaused;
  }
  if (req.body.integrationConfig && typeof req.body.integrationConfig === "object") {
    const [existingTenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId));
    let mergedConfig: Record<string, unknown> = {};
    if (existingTenant?.apiConfig && typeof existingTenant.apiConfig === "string") {
      try {
        mergedConfig = decryptConfig(existingTenant.apiConfig);
      } catch { /* start fresh if decrypt fails */ }
    }
    const newFields = req.body.integrationConfig as Record<string, unknown>;
    for (const [key, val] of Object.entries(newFields)) {
      if (val === undefined || val === null) continue;
      const strVal = String(val);
      if (strVal.startsWith("••••") || strVal.startsWith("****")) continue;
      if (strVal === "" || strVal === "__CLEAR__") {
        delete mergedConfig[key];
      } else {
        mergedConfig[key] = val;
      }
    }
    (updateData as Record<string, unknown>).apiConfig = encryptConfig(mergedConfig);
  }
  if (req.body.alertConfig && typeof req.body.alertConfig === "object") {
    (updateData as Record<string, unknown>).alertConfig = req.body.alertConfig;
  }
  if (req.body.communicationConfig && typeof req.body.communicationConfig === "object") {
    const validCallPlatforms = ["native", "callrail", "podium", "none"];
    const validTextPlatforms = ["native", "podium", "callrail", "none"];
    const rawComm = req.body.communicationConfig as Record<string, unknown>;
    if (rawComm.callPlatform && !validCallPlatforms.includes(String(rawComm.callPlatform))) {
      res.status(400).json({ error: `Invalid callPlatform. Must be one of: ${validCallPlatforms.join(", ")}` });
      return;
    }
    if (rawComm.textPlatform && !validTextPlatforms.includes(String(rawComm.textPlatform))) {
      res.status(400).json({ error: `Invalid textPlatform. Must be one of: ${validTextPlatforms.join(", ")}` });
      return;
    }
    const [existingForComm] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId));
    const existingComm = (existingForComm?.communicationConfig || {}) as Record<string, unknown>;
    const sanitizedComm: Record<string, unknown> = { ...existingComm };
    if (rawComm.callPlatform) sanitizedComm.callPlatform = rawComm.callPlatform;
    if (rawComm.textPlatform) sanitizedComm.textPlatform = rawComm.textPlatform;
    (updateData as Record<string, unknown>).communicationConfig = sanitizedComm;
  }
  if (req.body.leaderboardConfig && typeof req.body.leaderboardConfig === "object") {
    if (role !== "super_admin" && role !== "agency_user") {
      res.status(403).json({ error: "Only agency users can modify leaderboard settings" });
      return;
    }
    const rawLb = req.body.leaderboardConfig as Record<string, unknown>;
    const validDisplayModes = ["named", "anonymized"];
    const lbConfig: Record<string, unknown> = {};
    if (rawLb.visible !== undefined) lbConfig.visible = Boolean(rawLb.visible);
    if (rawLb.displayMode && validDisplayModes.includes(String(rawLb.displayMode))) {
      lbConfig.displayMode = rawLb.displayMode;
    }
    const [existingForLb] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId));
    const existingLb = (existingForLb?.leaderboardConfig || {}) as Record<string, unknown>;
    (updateData as Record<string, unknown>).leaderboardConfig = { ...existingLb, ...lbConfig };
  }
  if (req.body.revenueConfig && typeof req.body.revenueConfig === "object") {
    if (role !== "super_admin" && role !== "agency_user") {
      res.status(403).json({ error: "Only agency users can modify revenue settings" });
      return;
    }
    const rawRev = req.body.revenueConfig as Record<string, unknown>;
    if (rawRev.rebateLabels !== undefined) {
      if (!Array.isArray(rawRev.rebateLabels)) {
        res.status(400).json({ error: "rebateLabels must be an array of strings" });
        return;
      }
      // Normalize: trim, drop blanks, de-dupe case-insensitively. Storing an
      // empty list means "fall back to defaults" (handled on read), so we don't
      // persist an empty array as a meaningful override.
      const seen = new Set<string>();
      const cleaned: string[] = [];
      for (const raw of rawRev.rebateLabels as unknown[]) {
        if (typeof raw !== "string") {
          res.status(400).json({ error: "rebateLabels must be an array of strings" });
          return;
        }
        const label = raw.trim();
        if (!label) continue;
        if (label.length > 100) {
          res.status(400).json({ error: "Each rebate label must be 100 characters or fewer" });
          return;
        }
        const key = label.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        cleaned.push(label);
      }
      const [existingForRev] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId));
      const existingRev = (existingForRev?.revenueConfig || {}) as Record<string, unknown>;
      (updateData as Record<string, unknown>).revenueConfig = { ...existingRev, rebateLabels: cleaned };
    }
  }

  const [tenant] = await db.update(tenantsTable).set(updateData).where(eq(tenantsTable.id, tenantId)).returning();
  if (!tenant) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }
  res.json(sanitizeTenant(tenant));
});

router.get("/tenants/:tenantId/callrail-status", async (req, res) => {
  const { tenantId } = GetTenantParams.parse({ tenantId: req.params.tenantId });
  const access = assertResourceTenantAccess(req, res, tenantId, {
    deniedMessage: "Forbidden",
  });
  if (!access.ok) return;
  try {
    const [status] = await db.select().from(callrailWebhookStatusTable)
      .where(eq(callrailWebhookStatusTable.tenantId, tenantId));
    if (!status) {
      res.json({
        tenantId,
        lastSuccessAt: null,
        lastFailureAt: null,
        lastFailureReason: null,
        lastCallId: null,
      });
      return;
    }
    res.json(status);
  } catch (err) {
    console.warn(`[Tenants] callrail-status query failed for tenant ${tenantId}:`, err);
    res.json({
      tenantId,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastFailureReason: null,
      lastCallId: null,
      unavailable: true,
    });
  }
});

router.delete("/tenants/:tenantId", requireRole("super_admin", "agency_user"), async (req, res) => {
  const { tenantId } = GetTenantParams.parse({ tenantId: req.params.tenantId });
  const [tenant] = await db.update(tenantsTable).set({ isActive: false, updatedAt: new Date() }).where(eq(tenantsTable.id, tenantId)).returning();
  if (!tenant) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }
  res.json({ success: true, message: "Tenant deactivated" });
});

export default router;
