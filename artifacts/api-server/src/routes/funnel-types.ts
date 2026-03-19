import { Router, type IRouter } from "express";
import { db, funnelTypesTable, tenantsTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { requireRole } from "../middleware/auth";

const router: IRouter = Router();

router.get("/funnel-types", async (req, res) => {
  const tenantId = req.query.tenantId ? Number(req.query.tenantId) : null;
  const conditions = tenantId ? [eq(funnelTypesTable.tenantId, tenantId)] : [];
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const types = await db.select().from(funnelTypesTable).where(where).orderBy(desc(funnelTypesTable.createdAt));
  res.json(types);
});

router.post("/funnel-types", requireRole("super_admin", "agency_user"), async (req, res): Promise<void> => {
  const { tenantId, name, slug, description } = req.body;
  if (!tenantId || !name || !slug) {
    res.status(400).json({ error: "tenantId, name, and slug are required" });
    return;
  }
  const [ft] = await db.insert(funnelTypesTable).values({
    tenantId,
    name,
    slug: slug.toLowerCase().replace(/\s+/g, "-"),
    description: description || null,
  }).returning();
  res.status(201).json(ft);
});

router.put("/funnel-types/:id", requireRole("super_admin", "agency_user"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id));
  const { name, slug, description, isActive } = req.body;
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (name !== undefined) updates.name = name;
  if (slug !== undefined) updates.slug = slug.toLowerCase().replace(/\s+/g, "-");
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

  const funnels = await db.select().from(funnelTypesTable)
    .where(and(eq(funnelTypesTable.tenantId, tenantId), eq(funnelTypesTable.isActive, true)))
    .orderBy(funnelTypesTable.name);

  const funnelScripts = funnels.map(f => ({
    id: f.id,
    name: f.name,
    slug: f.slug,
    script: `<script src="${baseUrl}/tracker.js" data-tenant="${tenantId}" data-funnel="${f.slug}"></script>`,
  }));

  res.json({ tenantId, tenantName: tenant.name, script: baseScript, funnelScripts });
});

export default router;
