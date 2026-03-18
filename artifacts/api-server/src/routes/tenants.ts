import { Router, type IRouter } from "express";
import { db, tenantsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { CreateTenantBody, GetTenantParams, UpdateTenantBody } from "@workspace/api-zod";
import { requireRole } from "../middleware/auth";

const router: IRouter = Router();

router.get("/tenants", async (req, res) => {
  const role = req.session.userRole;
  if (role === "super_admin" || role === "agency_user") {
    const tenants = await db.select().from(tenantsTable);
    res.json(tenants);
  } else {
    const [user] = await db.select({ tenantId: usersTable.tenantId }).from(usersTable).where(eq(usersTable.id, req.session.userId!));
    if (!user?.tenantId) {
      res.json([]);
      return;
    }
    const tenants = await db.select().from(tenantsTable).where(eq(tenantsTable.id, user.tenantId));
    res.json(tenants);
  }
});

router.post("/tenants", requireRole("super_admin", "agency_user"), async (req, res) => {
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

router.patch("/tenants/:tenantId", requireRole("super_admin", "agency_user"), async (req, res) => {
  const { tenantId } = GetTenantParams.parse({ tenantId: req.params.tenantId });
  const body = UpdateTenantBody.parse(req.body);
  const updateData: Partial<typeof tenantsTable.$inferInsert> & { updatedAt: Date } = { updatedAt: new Date() };
  if (body.name !== undefined) updateData.name = body.name;
  if (body.serviceTitanId !== undefined) updateData.serviceTitanId = body.serviceTitanId;
  if (body.timezone !== undefined) updateData.timezone = body.timezone;
  if (body.isActive !== undefined) updateData.isActive = body.isActive;

  const [tenant] = await db.update(tenantsTable).set(updateData).where(eq(tenantsTable.id, tenantId)).returning();
  if (!tenant) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }
  res.json(tenant);
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
