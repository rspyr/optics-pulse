import { Router, type IRouter } from "express";
import { db, tenantsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { CreateTenantBody, GetTenantParams, UpdateTenantBody } from "@workspace/api-zod";
import { requireRole } from "../middleware/auth";
import { encryptConfig, decryptConfig } from "../lib/encryption";

const router: IRouter = Router();

const SECRET_FIELDS = new Set([
  "googleAdsApiKey",
  "googleAdsDeveloperToken",
  "callRailApiKey",
  "callRailSigningKey",
  "serviceTitanClientId",
  "serviceTitanClientSecret",
  "metaAccessToken",
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
  const insertData: Record<string, unknown> = {
    name: body.name,
    serviceTitanId: body.serviceTitanId,
    timezone: body.timezone || "America/New_York",
  };
  if (req.body.integrationConfig && typeof req.body.integrationConfig === "object") {
    insertData.apiConfig = encryptConfig(req.body.integrationConfig);
  }
  const [tenant] = await db.insert(tenantsTable).values(insertData as typeof tenantsTable.$inferInsert).returning();
  res.status(201).json(sanitizeTenant(tenant));
});

router.get("/tenants/:tenantId", async (req, res) => {
  const { tenantId } = GetTenantParams.parse({ tenantId: req.params.tenantId });
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

  if (role === "client_admin") {
    if (req.session.tenantId !== tenantId) {
      res.status(403).json({ error: "Cannot modify another tenant" });
      return;
    }
  } else if (role !== "super_admin" && role !== "agency_user") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const body = UpdateTenantBody.parse(req.body);
  const updateData: Partial<typeof tenantsTable.$inferInsert> & { updatedAt: Date } = { updatedAt: new Date() };
  if (body.name !== undefined) updateData.name = body.name;
  if (body.serviceTitanId !== undefined) updateData.serviceTitanId = body.serviceTitanId;
  if (body.timezone !== undefined) updateData.timezone = body.timezone;
  if (body.isActive !== undefined) updateData.isActive = body.isActive;
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
      if (val !== undefined && val !== null && val !== "") {
        const strVal = String(val);
        if (strVal.startsWith("••••") || strVal.startsWith("****")) continue;
        mergedConfig[key] = val;
      }
    }
    (updateData as Record<string, unknown>).apiConfig = encryptConfig(mergedConfig);
  }
  if (req.body.alertConfig && typeof req.body.alertConfig === "object") {
    (updateData as Record<string, unknown>).alertConfig = req.body.alertConfig;
  }
  if (req.body.communicationConfig && typeof req.body.communicationConfig === "object") {
    const validCallPlatforms = ["native", "callrail", "podium"];
    const validTextPlatforms = ["native", "podium"];
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

  const [tenant] = await db.update(tenantsTable).set(updateData).where(eq(tenantsTable.id, tenantId)).returning();
  if (!tenant) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }
  res.json(sanitizeTenant(tenant));
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
