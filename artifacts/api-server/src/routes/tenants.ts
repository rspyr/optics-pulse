import { Router, type IRouter } from "express";
import { db, tenantsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { CreateTenantBody, GetTenantParams, UpdateTenantBody } from "@workspace/api-zod";
import { requireRole } from "../middleware/auth";
import { encryptConfig, decryptConfig } from "../lib/encryption";

const router: IRouter = Router();

function sanitizeTenant(tenant: typeof tenantsTable.$inferSelect) {
  const result: Record<string, unknown> = { ...tenant };
  if (tenant.apiConfig && typeof tenant.apiConfig === "string") {
    try {
      const decrypted = decryptConfig(tenant.apiConfig);
      const masked: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(decrypted)) {
        if (typeof val === "string" && val.length > 4) {
          masked[key] = `****${val.slice(-4)}`;
        } else {
          masked[key] = val;
        }
      }
      result.apiConfig = masked;
      result.hasIntegrationConfig = true;
    } catch {
      result.apiConfig = null;
      result.hasIntegrationConfig = false;
    }
  } else {
    result.hasIntegrationConfig = false;
  }
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

router.patch("/tenants/:tenantId", requireRole("super_admin", "agency_user"), async (req, res) => {
  const { tenantId } = GetTenantParams.parse({ tenantId: req.params.tenantId });
  const body = UpdateTenantBody.parse(req.body);
  const updateData: Partial<typeof tenantsTable.$inferInsert> & { updatedAt: Date } = { updatedAt: new Date() };
  if (body.name !== undefined) updateData.name = body.name;
  if (body.serviceTitanId !== undefined) updateData.serviceTitanId = body.serviceTitanId;
  if (body.timezone !== undefined) updateData.timezone = body.timezone;
  if (body.isActive !== undefined) updateData.isActive = body.isActive;
  if (req.body.integrationConfig && typeof req.body.integrationConfig === "object") {
    updateData.apiConfig = encryptConfig(req.body.integrationConfig) as unknown as typeof updateData.apiConfig;
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
