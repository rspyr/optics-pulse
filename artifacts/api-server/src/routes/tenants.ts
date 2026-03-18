import { Router, type IRouter } from "express";
import { db, tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { CreateTenantBody, GetTenantParams } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/tenants", async (_req, res) => {
  const tenants = await db.select().from(tenantsTable);
  res.json(tenants);
});

router.post("/tenants", async (req, res) => {
  const body = CreateTenantBody.parse(req.body);
  const [tenant] = await db.insert(tenantsTable).values({
    name: body.name,
    serviceTitanId: body.serviceTitanId,
    timezone: body.timezone || "America/New_York",
  }).returning();
  res.status(201).json(tenant);
});

router.get("/tenants/:tenantId", async (req, res) => {
  const { tenantId } = GetTenantParams.parse({ tenantId: req.params.tenantId });
  const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId));
  if (!tenant) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }
  res.json(tenant);
});

router.patch("/tenants/:tenantId", async (req, res) => {
  const { tenantId } = GetTenantParams.parse({ tenantId: req.params.tenantId });
  const body = req.body;
  const updateData: Record<string, any> = { updatedAt: new Date() };
  if (body.name) updateData.name = body.name;
  if (body.serviceTitanId) updateData.serviceTitanId = body.serviceTitanId;
  if (body.timezone) updateData.timezone = body.timezone;
  if (body.isActive !== undefined) updateData.isActive = body.isActive;

  const [tenant] = await db.update(tenantsTable).set(updateData).where(eq(tenantsTable.id, tenantId)).returning();
  if (!tenant) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }
  res.json(tenant);
});

router.delete("/tenants/:tenantId", async (req, res) => {
  const { tenantId } = GetTenantParams.parse({ tenantId: req.params.tenantId });
  const [tenant] = await db.update(tenantsTable).set({ isActive: false, updatedAt: new Date() }).where(eq(tenantsTable.id, tenantId)).returning();
  if (!tenant) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }
  res.json({ success: true, message: "Tenant deactivated" });
});

export default router;
