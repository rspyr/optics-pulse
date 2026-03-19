import { Router, type IRouter } from "express";
import { db, funnelTypesTable, tenantFunnelTypesTable, tenantsTable } from "@workspace/db";
import { eq, and, desc, inArray } from "drizzle-orm";
import { requireRole } from "../middleware/auth";

const router: IRouter = Router();

router.get("/funnel-types", async (req, res) => {
  const tenantId = req.query.tenantId ? Number(req.query.tenantId) : null;

  if (tenantId) {
    const associations = await db.select({ funnelTypeId: tenantFunnelTypesTable.funnelTypeId })
      .from(tenantFunnelTypesTable)
      .where(eq(tenantFunnelTypesTable.tenantId, tenantId));
    const ids = associations.map(a => a.funnelTypeId);
    if (ids.length === 0) { res.json([]); return; }
    const types = await db.select().from(funnelTypesTable)
      .where(inArray(funnelTypesTable.id, ids))
      .orderBy(desc(funnelTypesTable.createdAt));
    res.json(types);
  } else {
    const types = await db.select().from(funnelTypesTable).orderBy(desc(funnelTypesTable.createdAt));
    res.json(types);
  }
});

router.post("/funnel-types", requireRole("super_admin", "agency_user"), async (req, res): Promise<void> => {
  const { name, slug, description } = req.body;
  if (!name || !slug) {
    res.status(400).json({ error: "name and slug are required" });
    return;
  }
  const normalizedSlug = slug.toLowerCase().replace(/\s+/g, "-");
  const [existing] = await db.select({ id: funnelTypesTable.id }).from(funnelTypesTable)
    .where(eq(funnelTypesTable.slug, normalizedSlug));
  if (existing) {
    res.status(409).json({ error: `A funnel type with slug "${normalizedSlug}" already exists` });
    return;
  }
  const [ft] = await db.insert(funnelTypesTable).values({
    name,
    slug: normalizedSlug,
    description: description || null,
  }).returning();
  res.status(201).json(ft);
});

router.put("/funnel-types/:id", requireRole("super_admin", "agency_user"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id));
  const { name, description, isActive } = req.body;
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (name !== undefined) updates.name = name;
  if (description !== undefined) updates.description = description;
  if (isActive !== undefined) updates.isActive = isActive;

  const [ft] = await db.update(funnelTypesTable).set(updates).where(eq(funnelTypesTable.id, id)).returning();
  if (!ft) { res.status(404).json({ error: "Funnel type not found" }); return; }
  res.json(ft);
});

router.delete("/funnel-types/:id", requireRole("super_admin", "agency_user"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id));
  const [ft] = await db.delete(funnelTypesTable).where(eq(funnelTypesTable.id, id)).returning();
  if (!ft) { res.status(404).json({ error: "Funnel type not found" }); return; }
  res.json({ success: true });
});

router.get("/funnel-types/script/:tenantId", async (req, res) => {
  const tenantId = parseInt(String(req.params.tenantId));
  const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId));
  if (!tenant) { res.status(404).json({ error: "Tenant not found" }); return; }

  const baseUrl = process.env.REPLIT_DEV_DOMAIN
    ? `https://${process.env.REPLIT_DEV_DOMAIN}`
    : "https://api.marketingos.app";

  const baseScript = `<script src="${baseUrl}/tracker.js" data-tenant="${tenantId}"></script>`;

  const associations = await db.select({ funnelTypeId: tenantFunnelTypesTable.funnelTypeId })
    .from(tenantFunnelTypesTable)
    .where(eq(tenantFunnelTypesTable.tenantId, tenantId));
  const ids = associations.map(a => a.funnelTypeId);

  let funnelScripts: { id: number; name: string; slug: string; script: string }[] = [];
  if (ids.length > 0) {
    const funnels = await db.select().from(funnelTypesTable)
      .where(and(inArray(funnelTypesTable.id, ids), eq(funnelTypesTable.isActive, true)))
      .orderBy(funnelTypesTable.name);

    funnelScripts = funnels.map(f => ({
      id: f.id,
      name: f.name,
      slug: f.slug,
      script: `<script src="${baseUrl}/tracker.js" data-tenant="${tenantId}" data-funnel="${f.slug}"></script>`,
    }));
  }

  res.json({ tenantId, tenantName: tenant.name, script: baseScript, funnelScripts });
});

router.post("/tenants/:id/funnel-types", requireRole("super_admin", "agency_user"), async (req, res): Promise<void> => {
  const tenantId = parseInt(String(req.params.id));
  const { funnelTypeId } = req.body;
  if (!funnelTypeId) { res.status(400).json({ error: "funnelTypeId is required" }); return; }

  const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId));
  if (!tenant) { res.status(404).json({ error: "Tenant not found" }); return; }

  const [ft] = await db.select().from(funnelTypesTable).where(eq(funnelTypesTable.id, funnelTypeId));
  if (!ft) { res.status(404).json({ error: "Funnel type not found" }); return; }

  await db.insert(tenantFunnelTypesTable).values({ tenantId, funnelTypeId })
    .onConflictDoNothing();
  res.status(201).json({ tenantId, funnelTypeId });
});

router.delete("/tenants/:id/funnel-types/:funnelTypeId", requireRole("super_admin", "agency_user"), async (req, res): Promise<void> => {
  const tenantId = parseInt(String(req.params.id));
  const funnelTypeId = parseInt(String(req.params.funnelTypeId));

  await db.delete(tenantFunnelTypesTable)
    .where(and(eq(tenantFunnelTypesTable.tenantId, tenantId), eq(tenantFunnelTypesTable.funnelTypeId, funnelTypeId)));
  res.json({ success: true });
});

router.get("/tenants/:id/funnel-types", async (req, res) => {
  const tenantId = parseInt(String(req.params.id));
  const associations = await db.select({ funnelTypeId: tenantFunnelTypesTable.funnelTypeId })
    .from(tenantFunnelTypesTable)
    .where(eq(tenantFunnelTypesTable.tenantId, tenantId));
  const ids = associations.map(a => a.funnelTypeId);
  if (ids.length === 0) { res.json([]); return; }
  const types = await db.select().from(funnelTypesTable)
    .where(inArray(funnelTypesTable.id, ids))
    .orderBy(funnelTypesTable.name);
  res.json(types);
});

export default router;
