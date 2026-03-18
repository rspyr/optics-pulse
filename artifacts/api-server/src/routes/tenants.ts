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

export default router;
